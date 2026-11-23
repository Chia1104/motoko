import { LeaseHeldError as RuntimeLeaseHeldError } from "../errors.ts";
import type { StorageScope } from "../host.ts";

import { describeScope } from "./scope.ts";

/**
 * Another holder has the scope's lease, and it has not expired. It is the runtime's `LeaseHeldError`, so a host built on
 * a shared-database store refuses a second writer the way every other host does.
 */
export class LeaseHeldError extends RuntimeLeaseHeldError {
  /** The holder's label, as it acquired the lease. */
  readonly holder: string | undefined;
  readonly expiresAt: Date | undefined;
  constructor(scope: StorageScope, holder: string | undefined, expiresAt: Date | undefined) {
    super(scope);
    this.message =
      `Scope ${describeScope(scope)} is leased by ${holder === undefined ? "another holder" : JSON.stringify(holder)}` +
      (expiresAt === undefined ? "" : ` until ${expiresAt.toISOString()}`);
    this.holder = holder;
    this.expiresAt = expiresAt;
  }
}

export type LeaseLossReason =
  /** Another holder acquired the lease (after it expired). */
  | "taken"
  /** The lease expired before it was renewed. */
  | "expired"
  /** No renewal reached the database within `ttlMs`, so the lease may have expired and been taken. */
  | "unreachable"
  /** The scope was deleted. */
  | "deleted"
  /** `release()` was called. */
  | "released";

/** The lease is no longer held; `signal.reason` of a lost lease, and the error of a commit it fenced off. */
export class LeaseLostError extends Error {
  readonly scope: StorageScope;
  readonly reason: LeaseLossReason;
  constructor(scope: StorageScope, reason: LeaseLossReason, options?: { cause?: unknown }) {
    super(`Lease of scope ${describeScope(scope)} is no longer held: ${reason}`, options);
    this.name = "LeaseLostError";
    this.scope = scope;
    this.reason = reason;
  }
}

/** A scope's row is gone: `deleteScope()` ran while this storage was open. */
export class ScopeDeletedError extends Error {
  constructor(scope: StorageScope) {
    super(`Scope ${describeScope(scope)} was deleted`);
    this.name = "ScopeDeletedError";
  }
}

/**
 * A commit found the scope's `next_seq` moved since it read it, under the same lease (two storages opened with one
 * lease); it wrote nothing.
 */
export class ConcurrentCommitError extends Error {
  constructor(scope: StorageScope) {
    super(`Another writer committed to scope ${describeScope(scope)}; this storage is no longer its single writer`);
    this.name = "ConcurrentCommitError";
  }
}
