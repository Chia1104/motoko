import type { ConversationId, Storage, Wake } from "@earendil-works/pi-durable";

import { LeaseHeldError } from "./errors.ts";

/** Names one instance by its agent kind and its name. `assertScope` says which scopes are valid. */
export interface StorageScope {
  kind: string;
  name: string;
}

/** A single-writer lease on one scope. `signal` aborts if the lease is lost. */
export interface Lease {
  readonly signal: AbortSignal;
  /**
   * Frees the scope. A second call does nothing. `wake` is pi-durable's `harness.wake()` as the instance closed, which
   * holds the work that can run and its earliest sleep. A host that keeps it uses it to say which scopes `unfinished()`
   * lists. A host that keeps nothing ignores it.
   */
  release(wake?: Wake): Promise<void>;
}

/**
 * How sleeping work is woken.
 *
 * - `process` is for a long-lived process, such as an Electron backend or a Node server. pi-durable's own timers wake
 *   sleeping work, and the runtime resumes unfinished work when it opens an instance.
 * - `alarm` is for an evictable host, such as a Durable Object. The runtime passes pi-durable's `onWake` through to
 *   `arm`. From before every call that can start work until the call is done, it arms only `{ active: true }`, also
 *   while other calls end and runs finish, so a host that dies is woken to recover that work. Once no such call is
 *   under way, it arms what is due. The host calls `AgentInstance.resume()` when its alarm fires.
 */
export type HostWake =
  | { readonly kind: "process" }
  | {
      readonly kind: "alarm";
      /** Keeps the scope's alarm at the earliest of `at` and, while `active`, a recovery heartbeat. */
      arm(scope: StorageScope, wake: Wake): Promise<void>;
    };

/**
 * The storage and the lease a database supplies for each instance. They always come as one pair, so a storage that
 * fences its commits with its own lease is only ever handed that lease.
 */
export interface AgentStore {
  /**
   * Acquires the single-writer lease for a scope. Rejects with `LeaseHeldError` while another writer
   * holds it. The runtime holds the lease for as long as the instance is open.
   */
  lease(scope: StorageScope): Promise<Lease>;
  /**
   * Opens the scope's pi-durable storage. The runtime calls it once per open of an instance, after its lease is held.
   * The instance's Harness owns the storage and closes it. `lease` is the one `lease(scope)` returned for this open. A
   * storage that fences its commits with it keeps a writer that lost the lease from writing whatever it still believes.
   */
  storage(scope: StorageScope, lease: Lease): Promise<Storage>;
  /**
   * Optional. Lists the scopes whose storage may hold work that needs a process, for `runtime.recover()`. That work is
   * a task that can run, was running, or sleeps until a time. The list never leaves such a scope out, so a scope that a
   * process crashed in or closed with such work is listed. It may list more, at the cost of opening them, and the
   * runtime lets go of those with nothing to do once they are idle.
   */
  unfinished?(): AsyncIterable<StorageScope>;
  /**
   * Optional. Erases deleted sessions from a scope's storage, each conversation with everything it owns. A
   * conversation owns its entries, tasks, submissions and documents, and the conversations its tasks made. The runtime
   * calls it with the scope's lease held and its storage closed. It skips a conversation that still has unfinished
   * work, one that another conversation forks from, and one it does not hold. The runtime asks again at the instance's
   * next close. Without it, a deleted session is hidden and its data stays.
   */
  erase?(scope: StorageScope, lease: Lease, conversations: readonly ConversationId[]): Promise<void>;
}

/** What the runtime takes, a store plus the environment's wake-ups. */
export interface AgentHost extends AgentStore {
  readonly wake: HostWake;
}

/** A stable string for a scope, for maps and lease tables. */
export function scopeKey(scope: StorageScope): string {
  return JSON.stringify([scope.kind, scope.name]);
}

const MAX_SCOPE_PART = 1024;

export function scopePartProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "must be a string";
  if (value.length === 0) return "must not be empty";
  if (!value.isWellFormed()) return "must be well-formed Unicode (no lone surrogates)";
  if (value.includes("\0")) return "must not contain a NUL character";
  if (codePointsExceed(value, MAX_SCOPE_PART)) return `must have at most ${MAX_SCOPE_PART} characters`;
  return undefined;
}

function codePointsExceed(value: string, max: number): boolean {
  return value.length > max && [...value].length > max;
}

/**
 * The one definition of a valid scope, for every host and storage. `kind` and `name` are each a string of 1 to 1024
 * Unicode code points that is well-formed Unicode by `isWellFormed()` and has no NUL character. Throws a `TypeError`
 * naming the part that is not.
 */
export function assertScope(scope: StorageScope): void {
  if (typeof scope !== "object" || scope === null)
    throw new TypeError("A scope must be an object with a kind and a name");
  for (const part of ["kind", "name"] as const) {
    const problem = scopePartProblem(scope[part]);
    if (problem !== undefined) throw new TypeError(`A scope's ${part} ${problem}`);
  }
}

/**
 * Leases held in this process's memory, one writer per scope among the hosts that share the returned function. It
 * cannot see other processes. A deployment where two processes may open the same storage needs a lease that can, such
 * as a lock file or a database advisory lock.
 */
export function inProcessLeases(): (scope: StorageScope) => Promise<Lease> {
  const held = new Set<string>();
  return async (scope) => {
    assertScope(scope);
    const key = scopeKey(scope);
    if (held.has(key)) throw new LeaseHeldError(scope);
    held.add(key);
    const neverAborted = new AbortController();
    let released = false;
    return {
      signal: neverAborted.signal,
      async release() {
        if (released) return;
        released = true;
        held.delete(key);
      },
    };
  };
}
