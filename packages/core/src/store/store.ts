import type { ConversationId, Storage } from "@earendil-works/pi-durable";

import type { AgentStore, Lease, StorageScope } from "../host.ts";

import { LeaseHeldError, LeaseLostError } from "./errors.ts";
import { acquireLease, FencedLease, LeaseRenewer, resolveLeaseOptions } from "./lease.ts";
import type { LeaseHolder, LeaseOptions, LeaseRow, LeaseStatements } from "./lease.ts";
import { validateScope } from "./scope.ts";

export type SharedStoreOptions = LeaseOptions & {
  /** Attempts of an idempotent statement on a transient connection error. It defaults to 3. */
  readonly attempts?: number;
};

/** What a store of one SQL dialect sends, over one database. */
export interface StoreDialect<S extends Storage> extends LeaseStatements {
  /** The package that makes the store, as its errors name it. */
  readonly name: string;
  /** The lease's holder label when the options name none, such as `hostname:pid`. */
  readonly defaultHolder: string;
  /**
   * Opens the storage of `lease`'s scope and checks the schema. When the scope's row is gone, or is another
   * incarnation of the scope whose row is no longer `lease.scopeId`, the scope was deleted since the lease was
   * acquired. Then the lease is lost as `deleted`, and the open rejects with its reason.
   */
  open(lease: FencedLease, attempts: number): Promise<S>;
  /**
   * At most `limit` scopes with a `scope_id` after `after`, in `scope_id` order, that may have unfinished work. Those
   * are the scopes whose last holder released the lease and left work that can run or a sleep, and those whose holder
   * never released it, once it expired. A scope whose lease is held and unexpired is left out.
   */
  unfinished(after: number, limit: number): Promise<readonly (StorageScope & { readonly scopeId: number })[]>;
  /**
   * Erases conversation `id` of `lease`'s scope, the conversations its tasks made, and everything they own, fenced as a
   * commit is, so only while `lease`'s token is current and unexpired. Skips it, erasing nothing, while any of them has
   * unfinished work or another conversation forks from one of them. Resolves whether the lease held.
   */
  erase(lease: LeaseRow, id: ConversationId): Promise<boolean>;
  /**
   * Deletes everything `scope` owns unless a lease other than `own` is unexpired. Resolves whether there was such a
   * scope, or who holds it.
   */
  deleteScope(scope: StorageScope, own: LeaseRow | undefined): Promise<boolean | LeaseHolder>;
  /** Rejects unless the database's schema is the dialect's. */
  checkSchema(): Promise<void>;
}

/**
 * Many independent pi-durable storages in one database, one per scope. It is the runtime's store, which a host adds its
 * wake-ups to. In a long-lived process, `nodeHost(store)` is that host.
 */
export interface SharedStore<S extends Storage = Storage> extends AgentStore {
  /**
   * Acquires the single-writer lease of `scope`. On first use it creates the scope's row with an INSERT, never DDL.
   * Rejects with `LeaseHeldError` while another holder's lease is unexpired, and when the database's schema is not the
   * store's. The lease renews itself until released or lost.
   */
  lease(scope: StorageScope): Promise<FencedLease>;
  /**
   * Opens the pi-durable storage of `lease`'s scope. The lease fences every commit. A commit's write requires the
   * lease's token to be current and unexpired by the database clock, so a writer that lost the lease writes nothing,
   * whatever it believes. `lease` must come from this store's `lease()` for this scope.
   *
   * It is a method, so the store is still an `AgentStore`, because a runtime hands it back the lease this store's
   * `lease()` made. A function type that may pass it any lease, such as a storage that `nodeHost` gives its default
   * lease, does not accept it. So the pair cannot be split where TypeScript checks it, and JavaScript that splits it
   * gets a `TypeError` at the first open.
   */
  storage(scope: StorageScope, lease: FencedLease): Promise<S>;
  /**
   * The scopes `runtime.recover()` opens. Those are the scopes whose last holder released the lease and left work that
   * can run or a sleep, and those whose holder crashed without releasing it, once their lease has expired. A scope held
   * now is left to its holder.
   */
  unfinished(): AsyncIterable<StorageScope>;
  /**
   * Erases deleted sessions of `lease`'s scope, each conversation with everything it owns, fenced by the lease as a
   * commit is. Skips a conversation that still has unfinished work or that another forks from.
   */
  erase(scope: StorageScope, lease: FencedLease, conversations: readonly ConversationId[]): Promise<void>;
  /**
   * Deletes everything `scope` owns. Resolves `false` when there was no such scope. Rejects with `LeaseHeldError` while
   * another holder's lease is unexpired. Pass the scope's own lease to delete a scope you hold, and that lease is lost
   * as `deleted` afterwards.
   */
  readonly deleteScope: (scope: StorageScope, lease?: Lease) => Promise<boolean>;
}

const UNFINISHED_PAGE_SIZE = 500;

/** The store over `dialect`'s database. */
export function createSharedStore<S extends Storage>(
  dialect: StoreDialect<S>,
  options: SharedStoreOptions = {},
): SharedStore<S> {
  const leaseOptions = resolveLeaseOptions(options, dialect.defaultHolder);
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError("attempts must be a positive integer");
  const renewer = new LeaseRenewer(dialect.name, dialect, leaseOptions.ttlMs, leaseOptions.renewIntervalMs);
  const own = (scope: StorageScope, lease: Lease) => FencedLease.of(dialect.name, scope, lease);
  return {
    async lease(scope) {
      return acquireLease(renewer, validateScope(scope), leaseOptions);
    },
    async storage(scope, lease) {
      return dialect.open(own(validateScope(scope), lease), attempts);
    },
    async *unfinished() {
      await dialect.checkSchema();
      let after = 0;
      for (;;) {
        const page = await dialect.unfinished(after, UNFINISHED_PAGE_SIZE);
        for (const { kind, name } of page) yield { kind, name };
        if (page.length < UNFINISHED_PAGE_SIZE) return;
        after = page.at(-1)!.scopeId;
      }
    },
    async erase(scope, lease, conversations) {
      const held = own(validateScope(scope), lease);
      for (const id of conversations) {
        if (!(await dialect.erase(held, id))) throw new LeaseLostError(held.scope, "expired");
      }
    },
    async deleteScope(scope, lease) {
      const valid = validateScope(scope);
      const held = lease === undefined ? undefined : own(valid, lease);
      await dialect.checkSchema();
      const deleted = await dialect.deleteScope(valid, held);
      if (typeof deleted !== "boolean") throw new LeaseHeldError(valid, deleted.holder, deleted.expiresAt);
      if (deleted) held?.lose("deleted");
      return deleted;
    },
  };
}
