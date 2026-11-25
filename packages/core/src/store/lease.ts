import type { Wake } from "@earendil-works/pi-durable";

import type { Lease, StorageScope } from "../host.ts";

import { LeaseHeldError, LeaseLostError } from "./errors.ts";
import type { LeaseLossReason } from "./errors.ts";
import { describeScope } from "./scope.ts";

export interface LeaseOptions {
  /** How long a lease lasts without renewal, so how long a crashed holder blocks its scope. It defaults to 30 s. */
  readonly ttlMs?: number;
  /** How often a holder renews. It defaults to `ttlMs / 3`. */
  readonly renewIntervalMs?: number;
  /**
   * A label for diagnostics, reported as `LeaseHeldError.holder`. It defaults to the dialect's label, which is
   * `hostname:pid` on Node.
   */
  readonly holder?: string;
}

export interface ResolvedLeaseOptions {
  readonly ttlMs: number;
  readonly renewIntervalMs: number;
  readonly holder: string;
}

const DEFAULT_TTL_MS = 30_000;

export function resolveLeaseOptions(options: LeaseOptions, defaultHolder: string): ResolvedLeaseOptions {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 100) throw new RangeError("ttlMs must be at least 100");
  const renewIntervalMs = options.renewIntervalMs ?? Math.floor(ttlMs / 3);
  if (!Number.isFinite(renewIntervalMs) || renewIntervalMs <= 0 || renewIntervalMs >= ttlMs) {
    throw new RangeError("renewIntervalMs must be positive and shorter than ttlMs");
  }
  return { ttlMs, renewIntervalMs, holder: options.holder ?? defaultHolder };
}

/** A lease as the database knows it: its scope's row and its fencing token. */
export interface LeaseRow {
  readonly scopeId: number;
  /** The fencing token, which increases with every acquisition of the scope's lease. */
  readonly token: number;
}

/** Who holds a scope's unexpired lease, as its row names them. `LeaseHeldError` reports it. */
export interface LeaseHolder {
  readonly holder: string | undefined;
  readonly expiresAt: Date | undefined;
}

/** What one renewal found for one of its leases. */
export interface Renewal extends LeaseRow {
  /** The scope's token now, or `undefined` when the scope's row is gone. */
  readonly leaseToken: number | undefined;
  /** Whether the renewal extended this lease. */
  readonly held: boolean;
}

/** The lease's statements, as a dialect sends them. Every expiry is by the database's clock, never this process's. */
export interface LeaseStatements {
  /**
   * Takes `scope`'s lease for `holder` until `ttlMs` from now, if it is free or expired. On first use it creates the
   * scope's row with an INSERT, never DDL, and the same statements check the schema before they write. Resolves the
   * lease's row, or who holds it. Rejects when the schema is not the dialect's.
   */
  acquire(scope: StorageScope, holder: string, ttlMs: number): Promise<LeaseRow | LeaseHolder>;
  /**
   * One renewal of all of `leases` together. It extends to `ttlMs` from now each lease that is still its holder's and
   * unexpired, and reads each scope's token, so a lease that was not extended learns why. Resolves one renewal per
   * lease whose scope it read, in any order.
   */
  renew(leases: readonly LeaseRow[], ttlMs: number): Promise<readonly Renewal[]>;
  /**
   * Frees the scope if `lease` is still its holder's. The same statement records `wake`, which is what the instance
   * left, for `unfinished()`. Without `wake` nothing says the scope is done, so it is recorded as having work that can
   * run.
   */
  release(lease: LeaseRow, wake: Wake | undefined): Promise<void>;
}

export class LeaseRenewer {
  readonly dialect: string;
  readonly statements: LeaseStatements;
  readonly ttlMs: number;
  readonly #renewIntervalMs: number;
  readonly #leases = new Set<FencedLease>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #renewing = false;

  constructor(dialect: string, statements: LeaseStatements, ttlMs: number, renewIntervalMs: number) {
    this.dialect = dialect;
    this.statements = statements;
    this.ttlMs = ttlMs;
    this.#renewIntervalMs = renewIntervalMs;
  }

  add(lease: FencedLease): void {
    this.#leases.add(lease);
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => void this.renew(), this.#renewIntervalMs);
      // SAFETY: Node.js timers have `unref`; other runtimes have nothing to unreference.
      (this.#timer as { unref?: () => void }).unref?.();
    }
  }

  delete(lease: FencedLease): void {
    this.#leases.delete(lease);
    if (this.#leases.size === 0 && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async renew(): Promise<void> {
    if (this.#renewing || this.#leases.size === 0) return;
    this.#renewing = true;
    const leases = [...this.#leases].filter((lease) => !lease.signal.aborted);
    const sentAt = performance.now();
    try {
      if (leases.length === 0) return;
      const outcomes = new Map<string, Renewal>();
      for (const renewal of await this.#confirmedRenewals(leases)) {
        outcomes.set(`${renewal.scopeId}:${renewal.token}`, renewal);
      }
      for (const lease of leases) {
        const outcome = outcomes.get(`${lease.scopeId}:${lease.token}`);
        if (outcome !== undefined) lease.renewed(sentAt, outcome.leaseToken, outcome.held);
      }
    } finally {
      this.#renewing = false;
    }
  }

  async #confirmedRenewals(leases: readonly FencedLease[]): Promise<readonly Renewal[]> {
    try {
      return await this.statements.renew(leases, this.ttlMs);
    } catch {
      return NO_RENEWALS_CONFIRMED;
    }
  }
}

const NO_RENEWALS_CONFIRMED: readonly Renewal[] = [];

/** A scope's lease as `store.lease()` returns it. `store.storage()` fences every commit with its token. */
export class FencedLease implements Lease, LeaseRow {
  readonly scope: StorageScope;
  readonly scopeId: number;
  /** The fencing token, which increases with every acquisition of the scope's lease. */
  readonly token: number;
  readonly ttlMs: number;
  readonly #renewer: LeaseRenewer;
  readonly #controller = new AbortController();
  #deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #releasing: Promise<void> | undefined;

  /** @internal Use `store.lease()`. */
  constructor(renewer: LeaseRenewer, scope: StorageScope, row: LeaseRow, acquiredAt: number) {
    this.#renewer = renewer;
    this.scope = scope;
    this.scopeId = row.scopeId;
    this.token = row.token;
    this.ttlMs = renewer.ttlMs;
    this.#armLocalDeadlineFrom(acquiredAt);
    renewer.add(this);
  }

  /**
   * @internal Returns `lease` as a lease that a store of `dialect` made for `scope`. Throws a `TypeError` for any
   * other lease, because a lease from anywhere else would fence nothing in the database.
   */
  static of(dialect: string, scope: StorageScope, lease: Lease): FencedLease {
    if (!(lease instanceof FencedLease) || lease.#renewer.dialect !== dialect) {
      throw new TypeError(`The lease must come from store.lease() of ${dialect}`);
    }
    if (lease.scope.kind !== scope.kind || lease.scope.name !== scope.name) {
      throw new TypeError(`The lease is for scope ${describeScope(lease.scope)}, not ${describeScope(scope)}`);
    }
    return lease;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * Gives the lease up. It stops renewing, aborts `signal` with the reason `released`, and frees the scope for the next
   * holder. The statement that frees it also records `wake`, which is what the instance left, for `unfinished()`.
   * Without `wake` nothing says the scope is done, so it is recorded as having work that can run.
   */
  release(wake?: Wake): Promise<void> {
    this.#releasing ??= (async () => {
      const held = !this.signal.aborted;
      this.#lose("released");
      if (!held) return;
      await this.#renewer.statements.release(this, wake);
    })();
    return this.#releasing;
  }

  /** @internal Marks the lease lost without touching the database. */
  lose(reason: LeaseLossReason, cause?: unknown): void {
    this.#lose(reason, cause);
  }

  /**
   * @internal A renewal sent at `sentAt` came back. Either it extended the lease, as `held` says, or the scope's token
   * is now `leaseToken`, which is `undefined` when the scope row is gone.
   */
  renewed(sentAt: number, leaseToken: number | undefined, held: boolean): void {
    if (this.signal.aborted) return;
    if (leaseToken === undefined) this.#lose("deleted");
    else if (held) this.#armLocalDeadlineFrom(sentAt);
    else this.#lose(leaseToken === this.token ? "expired" : "taken");
  }

  #lose(reason: LeaseLossReason, cause?: unknown): void {
    this.#renewer.delete(this);
    clearTimeout(this.#deadlineTimer);
    if (this.signal.aborted) return;
    this.#controller.abort(new LeaseLostError(this.scope, reason, cause === undefined ? undefined : { cause }));
  }

  #armLocalDeadlineFrom(sentAt: number): void {
    clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = setTimeout(
      () => this.#lose("unreachable"),
      Math.max(0, sentAt + this.ttlMs - performance.now()),
    );
    // SAFETY: Node.js timers have `unref`; other runtimes have nothing to unreference.
    (this.#deadlineTimer as { unref?: () => void }).unref?.();
  }
}

export async function acquireLease(
  renewer: LeaseRenewer,
  scope: StorageScope,
  options: ResolvedLeaseOptions,
): Promise<FencedLease> {
  const sentAt = performance.now();
  const row = await renewer.statements.acquire(scope, options.holder, options.ttlMs);
  if (!("token" in row)) throw new LeaseHeldError(scope, row.holder, row.expiresAt);
  return new FencedLease(renewer, scope, row, sentAt);
}
