// What the benchmark counts: every SQL statement sent through the `pg` pool (one `query()` call is one round trip),
// and every call into a pi-durable `Storage` on any backend, each with the code that caused it.
//
// Attribution: a Storage call is recorded with its caller, the nearest frame of the runtime (`packages/core/src`) on the
// call's (async) stack, else the nearest pi-durable frame. The Storage call runs inside an AsyncLocalStorage context, so
// every statement it sends is attributed to it; a statement outside any Storage call (the lease, opening a storage) is
// named by its text.
/* oxlint-disable typescript/no-explicit-any -- the meter patches pi-durable's objects at runtime, and their internals
   have no public types. */

import { AsyncLocalStorage } from "node:async_hooks";

import type { Storage } from "@earendil-works/pi-durable";
import type pg from "pg";

Error.stackTraceLimit = 60;

export interface StatementRecord {
  readonly start: number;
  end: number;
  /** What the statement is: `commit.read`, `scanEntries`, `lease.renew`, ... */
  readonly kind: string;
  /** The Storage method it ran in, if any. */
  readonly method: string | undefined;
  readonly caller: string;
  readonly text: string;
}

export interface StorageCallRecord {
  readonly start: number;
  end: number;
  readonly method: string;
  readonly caller: string;
  /** For a commit, what it writes: `entry pi.user`, `task pi.generation:running`, `doc pi.live`, ... */
  readonly writes?: string;
}

const SQL_KINDS: readonly [RegExp, string][] = [
  // Before the round-trip fixes: the separate schema check and scope row, as the lease and the storage open sent them.
  [/^select "name" from "agent_runtime_drizzle"\."migrations"/, "schema.check"],
  // After them: the lease's one acquiring statement and the storage's one opening statement, schema check included.
  [/^WITH journal AS/, "lease.acquire"],
  [/^SELECT ARRAY\(SELECT coalesce\("agent_runtime_drizzle"/, "storage.open"],
  [/^WITH existing AS/, "scope.ensure"],
  [/^update "agent_runtime"\."scopes" set "lease_token"/, "lease.acquire"],
  [/^select "lease_holder", "lease_expires_at"/, "lease.heldBy"],
  [/^with "renewed" as/, "lease.renew"],
  [/^update "agent_runtime"\."scopes" set "lease_holder"/, "lease.release"],
  [/^SELECT "s"\."next_id"/, "commit.read"],
  [/^WITH guard AS/, "commit.write"],
  [/^WITH b AS/, "document.read"],
  [/^select "lease_token", "lease_expires_at" > clock_timestamp\(\)/, "commit.guardDiagnosis"],
  [/^select "next_seq", "lease_token"/, "commit.readSeq"],
];

/** A statement's kind from its text, for statements sent outside a Storage call (and the commit's own). */
export function sqlKind(text: string): string | undefined {
  const trimmed = text.trimStart();
  for (const [pattern, kind] of SQL_KINDS) if (pattern.test(trimmed)) return kind;
  return undefined;
}

const FRAME = /^\s*at (?:async )?(?:(.*?) \()?(.*?):(\d+):\d+\)?$/;

/** pi-durable's plumbing between a caller and the Storage: never the frame that explains a call. */
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

/** The runtime frame nearest the top of `stack`, if any. */
export function runtimeFrameOf(stack: string | undefined): string | undefined {
  for (const { fn, file, row } of frames(stack)) {
    if (file.includes("/packages/core/src/")) return `${fn.replace(/^Object\./, "")} (${file.split("/").pop()}:${row})`;
  }
  return undefined;
}

/**
 * Who caused a Storage call: the runtime frame nearest the top of `stack`, else the runtime call it runs under (`runtime`), else
 * the nearest pi-durable frame that is not plumbing. A call from a pi-durable task (the scheduler runs it) is pi's.
 */
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

/** A commit's writes in a word each, for telling which pi-durable commit it was. */
function describeWrites(batches: unknown, documentKinds: Map<number, string>): string {
  const parts = new Set<string>();
  for (const batch of (batches as readonly (readonly Record<string, any>[])[]) ?? []) {
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

/** The records of one measured window. */
export interface Window {
  readonly statements: StatementRecord[];
  readonly storageCalls: StorageCallRecord[];
  readonly runtimeCalls: { start: number; call: string }[];
  /** The most statements in flight at once. */
  readonly maxInFlight: number;
}

export class Meter {
  readonly statements: StatementRecord[] = [];
  readonly storageCalls: StorageCallRecord[] = [];
  readonly #context = new AsyncLocalStorage<{ method: string; caller: string }>();
  /** The runtime's call into pi-durable that a Storage call runs under, as far as async context carries it. */
  readonly #runtimeCall = new AsyncLocalStorage<string>();
  readonly #documentKinds = new Map<number, string>();
  /** Every call the runtime made into the Harness or a Conversation, by runtime frame. */
  readonly runtimeCalls: { start: number; call: string }[] = [];
  #inFlight = 0;
  #maxInFlight = 0;
  #lastActivity = performance.now();

  /** In flight now, statements and Storage calls. */
  get busy(): number {
    return this.#inFlight;
  }

  get lastActivity(): number {
    return this.#lastActivity;
  }

  /** Starts a window: records from now on belong to it until `close`. */
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

  /** Resolves once nothing was sent or answered for `quietMs`. */
  async quiet(quietMs: number): Promise<void> {
    for (;;) {
      const idle = performance.now() - this.#lastActivity;
      if (this.#inFlight === 0 && idle >= quietMs) return;
      await new Promise((resolve) => setTimeout(resolve, Math.max(5, quietMs - idle)));
    }
  }

  /** Counts as activity now, so `quiet` waits a full period from here. */
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

  /** `pool` with every `query()` recorded: Drizzle sends each statement as one `query()` call. */
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

  /**
   * `storage` with every method call recorded. With `keepOpen`, `close()` leaves it open, so a MemoryStorage outlives
   * the runtime that used it, as a database outlives a process.
   */
  storage<S extends Storage>(storage: S, options: { keepOpen?: boolean } = {}): S {
    return new Proxy(storage, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const method = String(property);
        if (method === "close" && options.keepOpen) return async () => undefined;
        return (...args: unknown[]) => {
          // A commit runs on pi-durable's commit line, whose pump carries the async context of whoever started it,
          // not of whoever made the commit: it is named by what it writes instead.
          const caller = method === "commit" ? "commit" : callerOf(new Error().stack, this.#runtimeCall.getStore());
          const record: StorageCallRecord = {
            start: performance.now(),
            end: Number.NaN,
            method,
            caller,
            ...(method === "commit" && { writes: describeWrites(args[0], this.#documentKinds) }),
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
                (found: any) => {
                  const record = found?.record ?? found;
                  if (record?.id !== undefined && typeof record.kind === "string")
                    this.#documentKinds.set(record.id, record.kind);
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

  /**
   * Records each call the runtime makes into a Harness (and the Conversations it hands out) and runs it under that label,
   * so Storage calls it causes can name it. Patches `Harness.open` of this pi-durable module instance.
   */
  instrumentHarness(Harness: { open: (...args: any[]) => Promise<any> }): void {
    // The wrappers need their own `this` (the patched object) as well as the meter's private fields.
    // oxlint-disable-next-line typescript/no-this-alias
    const meter = this;
    const wrapped = new WeakSet<object>();
    const wrap = (target: any, names: readonly string[], kind: string) => {
      if (wrapped.has(target)) return;
      wrapped.add(target);
      for (const name of names) {
        const original = target[name];
        if (typeof original !== "function") continue;
        target[name] = function (this: unknown, ...args: unknown[]) {
          const frame = runtimeFrameOf(new Error().stack);
          if (frame === undefined) return original.apply(this, args);
          const call = `${frame.split(" ")[0]} → ${kind}.${name}`;
          meter.runtimeCalls.push({ start: performance.now(), call });
          const result = meter.#runtimeCall.run(call, () => original.apply(this, args));
          if (result instanceof Promise && name === "conversation") {
            void result.then(
              (conversation: any) => {
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
    const open = Harness.open.bind(Harness);
    Harness.open = async (...args: any[]) => {
      const harness = await open(...args);
      wrap(
        Object.getPrototypeOf(harness),
        ["conversation", "commit", "snapshot", "observeConversation", "inspect", "createConversation"],
        "harness",
      );
      return harness;
    };
  }
}

/** Counts of `key` over `records`, most first. */
export function tally<T>(records: readonly T[], key: (record: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(key(record), (counts.get(key(record)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
