/**
 * `@chia1104/motoko-core/store`: what every shared-database store has in common, whatever its SQL dialect. Many scopes
 * share one database; each scope has a row lease with a fencing token and an expiry by the database clock, and a
 * pi-durable storage that commits in one read of the check state, the checks in memory, and one guarded atomic write.
 *
 * A dialect package (Postgres, MySQL) writes the statements: `StoreDialect` for the store and its lease, and a
 * `CommitPort` per storage, whose `commit()` is `commitBatches`. `createSharedStore` makes the store; a `StorageShell`
 * does the rest of each storage that is not SQL. Like the rest of the core, it uses no Node built-ins.
 */
export { commitBatches } from "./commit.ts";
export type {
  CheckQuery,
  CheckState,
  CommitGuard,
  CommitPlan,
  CommitPort,
  PlannedRevision,
  RecordTable,
  WriteOutcome,
} from "./commit.ts";
export { ConcurrentCommitError, LeaseHeldError, LeaseLostError, ScopeDeletedError } from "./errors.ts";
export type { LeaseLossReason } from "./errors.ts";
export { FencedLease } from "./lease.ts";
export type { LeaseHolder, LeaseOptions, LeaseRow, LeaseStatements, Renewal } from "./lease.ts";
export { retry } from "./retry.ts";
export {
  addressKey,
  addressParts,
  encodeIndexedString,
  encodeJson,
  idFromNumber,
  isCurrentOnly,
  parseJson,
  partsKey,
  scopeColumns,
  seqFromNumber,
  toNumber,
} from "./rows.ts";
export type { AddressParts, ScopeKind } from "./rows.ts";
export { materializeDocument, StorageShell } from "./shell.ts";
export type { DocumentRows, StorageShellOptions } from "./shell.ts";
export { createSharedStore } from "./store.ts";
export type { SharedStore, SharedStoreOptions, StoreDialect } from "./store.ts";
