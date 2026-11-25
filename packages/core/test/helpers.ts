import type { CredentialStore } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { RegisterFauxProviderOptions } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import { expect } from "vite-plus/test";

import { decodeCursor, encodeCursor, foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

import { inProcessLeases, scopeKey } from "../src/index.ts";
import type { AgentHost, AgentSession, Lease, StorageScope } from "../src/index.ts";

export function memoryHost(): AgentHost {
  return {
    wake: { kind: "process" },
    lease: inProcessLeases(),
    async storage() {
      return new MemoryStorage();
    },
  };
}

export interface MemoryPlace {
  readonly storages: Map<string, MemoryStorage>;
  readonly leases: (scope: StorageScope) => Promise<Lease>;
  readonly log: string[];
  readonly writers: Map<string, number>;
}

export function memoryPlace(): MemoryPlace {
  return { storages: new Map(), leases: inProcessLeases(), log: [], writers: new Map() };
}

export function durableMemoryHost(
  place: MemoryPlace = memoryPlace(),
  hooks: { releasing?: (scope: StorageScope) => Promise<void> } = {},
): AgentHost {
  const label = (scope: StorageScope) => `${scope.kind}/${scope.name}`;
  return {
    wake: { kind: "process" },
    async lease(scope: StorageScope): Promise<Lease> {
      const lease = await place.leases(scope);
      place.log.push(`acquire ${label(scope)}`);
      let released = false;
      return {
        signal: lease.signal,
        async release() {
          if (released) return;
          released = true;
          await hooks.releasing?.(scope);
          await lease.release();
          place.log.push(`release ${label(scope)}`);
        },
      };
    },
    async storage(scope: StorageScope): Promise<Storage> {
      const key = scopeKey(scope);
      let memory = place.storages.get(key);
      if (!memory) {
        memory = new MemoryStorage();
        place.storages.set(key, memory);
      }
      const writers = (place.writers.get(key) ?? 0) + 1;
      place.writers.set(key, writers);
      if (writers > 1) throw new Error(`Two writers on ${label(scope)}`);
      const target = memory;
      // The Harness closes its storage. The data stays, as a database's data stays when a connection closes.
      return new Proxy(target, {
        get(object, property) {
          if (property === "close") {
            return async () => {
              place.writers.set(key, (place.writers.get(key) ?? 1) - 1);
            };
          }
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
}

function credentialStore(key: () => string | undefined): CredentialStore {
  return {
    async read() {
      const value = key();
      return value === undefined ? undefined : { type: "api_key", key: value };
    },
    async list() {
      return key() === undefined ? [] : [{ providerId: "keyed", type: "api_key" }];
    },
    async modify() {
      throw new Error("read-only in tests");
    },
    async delete() {
      throw new Error("read-only in tests");
    },
  };
}

export function keyedModels(key: () => string | undefined) {
  const core = createFauxCore({ provider: "keyed", models: [{ id: "keyed-1" }] });
  const provider = createProvider({
    id: "keyed",
    auth: {
      apiKey: {
        name: "Keyed",
        resolve: async ({ credential }) =>
          credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } },
      },
    },
    models: core.models,
    api: { stream: core.stream, streamSimple: core.streamSimple },
  });
  const models = createModels({ credentials: credentialStore(key) });
  models.setProvider(provider);
  return { faux: core, models };
}

export const keyedModel = { provider: "keyed", modelId: "keyed-1" };

export function fauxModels(options?: RegisterFauxProviderOptions) {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
}

export async function readUntil(
  session: AgentSession,
  until: (event: AgentWireEvent, items: readonly StreamItem[]) => boolean,
  options: { from?: string; timeoutMs?: number } = {},
): Promise<StreamItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  const items: StreamItem[] = [];
  try {
    for await (const item of session.events({
      ...(options.from !== undefined && { from: options.from }),
      signal: controller.signal,
    })) {
      items.push(item);
      if (until(item.event, items)) return items;
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`Stream ended before the expected event; read: ${items.map((item) => item.event.type).join(", ")}`);
}

export const settledTypes = (items: readonly StreamItem[]) =>
  items
    .map((item) => item.event.type)
    .filter(
      (type) =>
        type !== "assistant:start" &&
        type !== "assistant:delta" &&
        type !== "tool:draft" &&
        type !== "tool:update" &&
        type !== "queue",
    );

export const isRunEnd = (event: AgentWireEvent) => event.type === "run:end";

export function follow(session: AgentSession, from?: string) {
  const controller = new AbortController();
  const items: StreamItem[] = [];
  const listeners = new Set<() => void>();
  const done = (async () => {
    for await (const item of session.events({ ...(from !== undefined && { from }), signal: controller.signal })) {
      items.push(item);
      for (const listener of listeners) listener();
    }
  })();
  return {
    items,
    async until(until: (items: readonly StreamItem[]) => boolean, timeoutMs = 5_000): Promise<StreamItem[]> {
      if (until(items)) return items;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out; read: ${items.map((item) => item.event.type).join(", ")}`));
        }, timeoutMs);
        const check = () => {
          if (!until(items)) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        };
        listeners.add(check);
      });
      return items;
    },
    async stop(): Promise<void> {
      controller.abort();
      await done;
    },
  };
}

export async function eventually(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const runEnds = (items: readonly StreamItem[]) => items.filter((item) => isRunEnd(item.event)).length;

export function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function committedOnly(cursor: string): string {
  const position = decodeCursor(cursor);
  if (!position) throw new Error(`Not a cursor: ${cursor}`);
  const { log: _log, ...rest } = position;
  return encodeCursor(rest);
}

export async function expectEveryResumeFolds(session: AgentSession, live: readonly StreamItem[]): Promise<void> {
  const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));
  const view = fold(live);
  const last = live.at(-1)!.cursor;
  for (const [index, { cursor, event }] of live.slice(0, -1).entries()) {
    for (const from of [cursor, committedOnly(cursor)]) {
      const back = await readUntil(session, (_event, items) => items.at(-1)!.cursor === last, { from });
      expect(fold([...live.slice(0, index + 1), ...back]), `resumed after ${event.type} at ${from}`).toEqual(view);
    }
  }
}
