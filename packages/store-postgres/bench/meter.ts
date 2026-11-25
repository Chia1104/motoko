import { AsyncLocalStorage } from "node:async_hooks";

import type {
  Conversation,
  DocumentId,
  DocumentRecord,
  Harness,
  Storage,
  StorageWrite,
  StoredDocument,
} from "@earendil-works/pi-durable";
import type pg from "pg";

Error.stackTraceLimit = 60;

export interface StatementRecord {
  readonly start: number;
  end: number;
  readonly kind: string;
  readonly method: string | undefined;
  readonly caller: string;
  readonly text: string;
}

export interface StorageCallRecord {
  readonly start: number;
  end: number;
  readonly method: string;
  readonly caller: string;
  readonly writes?: string;
}

const SQL_KINDS: readonly [RegExp, string][] = [
  [/^WITH journal AS/, "lease.acquire"],
  [/^SELECT ARRAY\(SELECT coalesce\("agent_runtime_drizzle"/, "storage.open"],
  [/^select "lease_holder", "lease_expires_at"/, "lease.heldBy"],
  [/^with "renewed" as/, "lease.renew"],
  [/^update "agent_runtime"\."scopes" set "lease_holder"/, "lease.release"],
  [/^SELECT "s"\."next_id"/, "commit.read"],
  [/^WITH guard AS/, "commit.write"],
  [/^WITH b AS/, "document.read"],
  [/^select "lease_token", "lease_expires_at" > clock_timestamp\(\)/, "commit.guardDiagnosis"],
];

const SQL_KINDS_BEFORE_ROUND_TRIP_FIXES: readonly [RegExp, string][] = [
  [/^select "name" from "agent_runtime_drizzle"\."migrations"/, "schema.check"],
  [/^WITH existing AS/, "scope.ensure"],
  [/^update "agent_runtime"\."scopes" set "lease_token"/, "lease.acquire"],
  [/^select "next_seq", "lease_token"/, "commit.readSeq"],
];

export function sqlKind(text: string): string | undefined {
  const trimmed = text.trimStart();
  for (const [pattern, kind] of [...SQL_KINDS, ...SQL_KINDS_BEFORE_ROUND_TRIP_FIXES]) {
    if (pattern.test(trimmed)) return kind;
  }
  return undefined;
}

const FRAME = /^\s*at (?:async )?(?:(.*?) \()?(.*?):(\d+):\d+\)?$/;

const PLUMBING = /\/pi-durable\/dist\/session\/(cached-storage|session|keys|transaction|writer|line)\.js$/;

function frames(stack: string | undefined): { fn: string; file: string; row: string }[] {
  const list: { fn: string; file: string; row: string }[] = [];
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = FRAME.exec(line);
    if (!match) continue;
    list.push({ fn: match[1] ?? "<anonymous>", file: (match[2] ?? "").replace(/^file:\/\//, ""), row: match[3] ?? "" });
  }
  return list;
}

export function runtimeFrameOf(stack: string | undefined): string | undefined {
  for (const { fn, file, row } of frames(stack)) {
    if (file.includes("/packages/core/src/")) return `${fn.replace(/^Object\./, "")} (${file.split("/").pop()}:${row})`;
  }
  return undefined;
}

export function callerOf(stack: string | undefined, runtime?: string): string {
  const list = frames(stack);
  const inTask = list.some(({ file }) => file.endsWith("/harness/scheduler.js"));
  let pi: string | undefined;
  for (const { fn, file, row } of list) {
    if (file.includes("/packages/core/src/"))
      return `runtime ${fn.replace(/^Object\./, "")} (${file.split("/").pop()}:${row})`;
    if (pi === undefined && file.includes("/pi-durable/dist/") && !PLUMBING.test(file)) {
      pi = `pi ${fn} (${file.split("/pi-durable/dist/")[1]}:${row})`;
    }
  }
  if (!inTask && runtime !== undefined) return `runtime ${runtime}`;
  return pi ?? (runtime !== undefined ? `runtime ${runtime}` : "(no caller frame: a thenable or a queue between)");
}

function describeWrites(
  batches: readonly (readonly StorageWrite[])[] | undefined,
  documentKinds: Map<DocumentId, string>,
): string {
  const parts = new Set<string>();
  for (const batch of batches ?? []) {
    for (const write of batch) {
      switch (write.type) {
        case "conversation":
          parts.add("conversation");
          break;
        case "entry":
          parts.add(`entry ${write.value.kind}`);
          break;
        case "task":
          parts.add(`task ${write.value.kind}:${write.value.state?.status}`);
          break;
        case "submission":
          parts.add(`submission:${write.value.status}`);
          break;
        case "document.create":
        case "document.copy":
          documentKinds.set(write.record.id, write.record.kind);
          parts.add(`+doc ${write.record.kind}`);
          break;
        case "document.change":
          parts.add(`doc ${documentKinds.get(write.id) ?? `#${write.id}`}`);
          break;
        case "document.retire":
          parts.add(`-doc ${documentKinds.get(write.id) ?? `#${write.id}`}`);
          break;
      }
    }
  }
  const count = Array.isArray(batches) ? batches.length : 0;
  return `${count > 1 ? `${count} batches: ` : ""}${[...parts].sort().join(", ")}`;
}

export interface Window {
  readonly statements: StatementRecord[];
  readonly storageCalls: StorageCallRecord[];
  readonly runtimeCalls: { start: number; call: string }[];
  readonly maxInFlight: number;
}

export class Meter {
  readonly statements: StatementRecord[] = [];
  readonly storageCalls: StorageCallRecord[] = [];
  readonly #context = new AsyncLocalStorage<{ method: string; caller: string }>();
  readonly #runtimeCall = new AsyncLocalStorage<string>();
  readonly #documentKinds = new Map<DocumentId, string>();
  readonly runtimeCalls: { start: number; call: string }[] = [];
  #inFlight = 0;
  #maxInFlight = 0;
  #lastActivity = performance.now();

  get busy(): number {
    return this.#inFlight;
  }

  get lastActivity(): number {
    return this.#lastActivity;
  }

  open(): { close(): Window } {
    const statements = this.statements.length;
    const calls = this.storageCalls.length;
    this.#maxInFlight = this.#inFlight;
    const runtimeCalls = this.runtimeCalls.length;
    return {
      close: () => ({
        statements: this.statements.slice(statements),
        storageCalls: this.storageCalls.slice(calls),
        runtimeCalls: this.runtimeCalls.slice(runtimeCalls),
        maxInFlight: this.#maxInFlight,
      }),
    };
  }

  async quiet(quietMs: number): Promise<void> {
    for (;;) {
      const idle = performance.now() - this.#lastActivity;
      if (this.#inFlight === 0 && idle >= quietMs) return;
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, quietMs - idle)));
    }
  }

  touch(): void {
    this.#lastActivity = performance.now();
  }

  #begin(): void {
    this.#inFlight++;
    this.#maxInFlight = Math.max(this.#maxInFlight, this.#inFlight);
    this.#lastActivity = performance.now();
  }

  #finish(): void {
    this.#inFlight--;
    this.#lastActivity = performance.now();
  }

  /** Drizzle sends each statement as one `query()` call. */
  pool(pool: pg.Pool): pg.Pool {
    return new Proxy(pool, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property !== "query") return value.bind(target);
        return async (...args: unknown[]) => {
          const first = args[0];
          const text = typeof first === "string" ? first : String((first as { text?: unknown }).text);
          const context = this.#context.getStore();
          const kind = sqlKind(text) ?? context?.method ?? `other: ${text.slice(0, 60)}`;
          const record: StatementRecord = {
            start: performance.now(),
            end: Number.NaN,
            kind,
            method: context?.method,
            caller: context?.caller ?? callerOf(new Error().stack),
            text,
          };
          this.statements.push(record);
          this.#begin();
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } finally {
            record.end = performance.now();
            this.#finish();
          }
        };
      },
    });
  }

  storage<S extends Storage>(storage: S, options: { keepOpen?: boolean } = {}): S {
    return new Proxy(storage, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const method = String(property);
        if (method === "close" && options.keepOpen) return async () => undefined;
        return (...args: unknown[]) => {
          // A commit runs on pi-durable's commit line, whose pump carries the async context of whoever started the
          // pump, not of whoever made the commit. So the meter names a commit by what it writes.
          const caller = method === "commit" ? "commit" : callerOf(new Error().stack, this.#runtimeCall.getStore());
          const record: StorageCallRecord = {
            start: performance.now(),
            end: Number.NaN,
            method,
            caller,
            ...(method === "commit" && {
              writes: describeWrites(args[0] as readonly (readonly StorageWrite[])[] | undefined, this.#documentKinds),
            }),
          };
          this.storageCalls.push(record);
          this.#begin();
          let result: unknown;
          try {
            const label = record.writes === undefined ? caller : `${caller} [${record.writes}]`;
            result = this.#context.run({ method, caller: label }, () =>
              (value as (...a: unknown[]) => unknown).apply(target, args),
            );
          } catch (error) {
            record.end = performance.now();
            this.#finish();
            throw error;
          }
          if (result instanceof Promise) {
            if (method === "findDocument" || method === "document") {
              void result.then(
                (found: DocumentRecord | StoredDocument | undefined) => {
                  const record = found !== undefined && "record" in found ? found.record : found;
                  if (record !== undefined) this.#documentKinds.set(record.id, record.kind);
                },
                () => undefined,
              );
            }
            return result.finally(() => {
              record.end = performance.now();
              this.#finish();
            });
          }
          record.end = performance.now();
          this.#finish();
          return result;
        };
      },
    });
  }

  instrumentHarness(harnessModule: typeof Harness): void {
    // oxlint-disable-next-line typescript/no-this-alias
    const meter = this;
    const wrapped = new WeakSet<object>();
    const wrap = (target: Record<string, unknown>, names: readonly string[], kind: string) => {
      if (wrapped.has(target)) return;
      wrapped.add(target);
      for (const name of names) {
        const original = target[name];
        if (typeof original !== "function") continue;
        target[name] = function (this: unknown, ...args: unknown[]): unknown {
          const frame = runtimeFrameOf(new Error().stack);
          if (frame === undefined) return original.apply(this, args);
          const call = `${frame.split(" ")[0]} → ${kind}.${name}`;
          meter.runtimeCalls.push({ start: performance.now(), call });
          const result = meter.#runtimeCall.run(call, () => original.apply(this, args));
          if (result instanceof Promise && name === "conversation") {
            void result.then(
              (conversation: Conversation | undefined) => {
                if (conversation)
                  wrap(Object.getPrototypeOf(conversation), ["submit", "entries", "abort"], "conversation");
              },
              () => undefined,
            );
          }
          return result;
        };
      }
    };
    const open = harnessModule.open.bind(harnessModule);
    harnessModule.open = async (storage, options, context) => {
      const harness = await open(storage, options, context);
      wrap(
        Object.getPrototypeOf(harness),
        ["conversation", "commit", "snapshot", "observeConversation", "inspect", "createConversation"],
        "harness",
      );
      return harness;
    };
  }
}

export function tally<T>(records: readonly T[], key: (record: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(key(record), (counts.get(key(record)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
