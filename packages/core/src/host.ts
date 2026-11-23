import type { ConversationId, Storage, Wake } from "@earendil-works/pi-durable";

import { LeaseHeldError } from "./errors.ts";

/**
 * The host contract. pi-durable keeps durability in the Storage (everything is committed before it
 * is shown, and `resume()` carries on interrupted work), so a host supplies only three things per
 * agent instance: its storage, a single-writer guarantee, and wake-ups. A database supplies the first
 * two as a store (`AgentStore`), and an environment adds the wake-ups (`AgentHost`). Two more are
 * optional: listing the scopes that may have unfinished work (`unfinished`), and erasing deleted
 * sessions (`erase`).
 */

/** One agent instance: an agent kind and the instance's name. Valid as `assertScope` says. */
export interface StorageScope {
  kind: string;
  name: string;
}

/** A single-writer lease on one scope. `signal` aborts if the lease is lost. */
export interface Lease {
  readonly signal: AbortSignal;
  /**
   * Frees the scope; a second call does nothing. `wake` is what the instance left as it closed (pi-durable's
   * `harness.wake()`: work that can run, and its earliest sleep), for a host that keeps it to say which scopes
   * `unfinished()` lists. A host that keeps nothing ignores it.
   */
  release(wake?: Wake): Promise<void>;
}

/**
 * How sleeping work is woken.
 *
 * - `process`: a long-lived process (an Electron backend, a Node server). pi-durable's own timers
 *   wake sleeping work; the runtime resumes unfinished work when it opens an instance.
 * - `alarm`: an evictable host (a Durable Object). The runtime passes pi-durable's `onWake` through to
 *   `arm`. From before every call that can start work until the call is done, it arms only
 *   `{ active: true }`, also while other calls end and runs finish, so a host that dies is woken to
 *   recover it; once no such call is under way, it arms what is due. The host calls
 *   `AgentInstance.resume()` when its alarm fires.
 */
export type HostWake =
  | { readonly kind: "process" }
  | {
      readonly kind: "alarm";
      /** Keeps the scope's alarm at the earliest of `at` and, while `active`, a recovery heartbeat. */
      arm(scope: StorageScope, wake: Wake): Promise<void>;
    };

/**
 * What a database supplies per agent instance: its storage and its lease, always as one pair, so a storage that fences
 * its commits with its own lease is only ever handed that lease.
 */
export interface AgentStore {
  /**
   * Acquires the single-writer lease for a scope. Rejects with `LeaseHeldError` while another writer
   * holds it. The runtime holds the lease for as long as the instance is open.
   */
  lease(scope: StorageScope): Promise<Lease>;
  /**
   * Opens the scope's pi-durable storage. Called once per open of an instance, after its lease is
   * held; the instance's Harness owns the storage and closes it. `lease` is the one `lease(scope)`
   * returned for this open, for a storage that fences its commits with it, so a writer that lost
   * the lease cannot write whatever it still believes.
   */
  storage(scope: StorageScope, lease: Lease): Promise<Storage>;
  /**
   * Optional: the scopes whose storage may hold work that needs a process (a task that can run, was running, or
   * sleeps until a time), for `runtime.recover()`. Never fewer than those: a scope a process crashed in, or closed
   * with such work, is listed. More is allowed, at the cost of opening them; the runtime lets go of those with
   * nothing to do once they are idle.
   */
  unfinished?(): AsyncIterable<StorageScope>;
  /**
   * Optional: erases deleted sessions from a scope's storage, each conversation with everything it owns (its
   * entries, tasks, submissions and documents, and the conversations its tasks made). The runtime calls it with the
   * scope's lease held and its storage closed. It skips a conversation that still has unfinished work or that another
   * conversation forks from, and one it does not hold; the runtime asks again at the instance's next close.
   * Without it, a deleted session is hidden and its data stays.
   */
  erase?(scope: StorageScope, lease: Lease, conversations: readonly ConversationId[]): Promise<void>;
}

/** What the runtime takes: a store plus the environment's wake-ups. */
export interface AgentHost extends AgentStore {
  readonly wake: HostWake;
}

/** A stable string for a scope, for maps and lease tables. */
export function scopeKey(scope: StorageScope): string {
  return JSON.stringify([scope.kind, scope.name]);
}

/** The most characters (Unicode code points) a scope's kind or name may have. */
const MAX_SCOPE_PART = 1024;

/** Why `value` is not a valid scope kind or name, or `undefined` when it is. */
export function scopePartProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "must be a string";
  if (value.length === 0) return "must not be empty";
  if (!value.isWellFormed()) return "must be well-formed Unicode (no lone surrogates)";
  if (value.includes("\0")) return "must not contain a NUL character";
  // Code points, not UTF-16 units; at most 2 units each, so only long strings need counting.
  if (value.length > MAX_SCOPE_PART && [...value].length > MAX_SCOPE_PART) {
    return `must have at most ${MAX_SCOPE_PART} characters`;
  }
  return undefined;
}

/**
 * The one definition of a valid scope, for every host and storage: `kind` and `name` are strings
 * of 1 to 1024 characters (Unicode code points), well-formed Unicode (`isWellFormed()`), with no
 * NUL character. Throws a `TypeError` naming the part that is not.
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
 * Leases held in this process's memory: one writer per scope among the hosts that share the returned function. It
 * cannot see other processes; a deployment where two processes may open the same storage needs a lease that can (a
 * lock file, a database advisory lock).
 */
export function inProcessLeases(): (scope: StorageScope) => Promise<Lease> {
  const held = new Set<string>();
  return async (scope) => {
    assertScope(scope);
    const key = scopeKey(scope);
    if (held.has(key)) throw new LeaseHeldError(scope);
    held.add(key);
    // An in-process lease is lost only by releasing it.
    const controller = new AbortController();
    let released = false;
    return {
      signal: controller.signal,
      async release() {
        if (released) return;
        released = true;
        held.delete(key);
      },
    };
  };
}
