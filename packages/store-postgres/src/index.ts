import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { checkSchemaOf, migrateOn } from "./migrations.ts";
import type { MigrateResult } from "./migrations.ts";
import { createStore } from "./store.ts";
import type { PostgresStore, PostgresStoreOptions } from "./store.ts";

export { isTransientError } from "./database.ts";
export {
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  type MigrateResult,
  type SchemaState,
  SchemaVersionError,
  supportedMigrations,
} from "./migrations.ts";
export {
  ConcurrentCommitError,
  LeaseHeldError,
  type LeaseLossReason,
  LeaseLostError,
  type LeaseOptions,
  ScopeDeletedError,
} from "@chia1104/motoko-core/store";
export type { PostgresStorage } from "./storage.ts";
export type { PostgresLease, PostgresStore, PostgresStoreOptions } from "./store.ts";

/**
 * Creates the store over `pool`. It is the runtime's store on the runtime's tables, whose host is `nodeHost(store)`,
 * and it serves `store.deleteScope` for any scope. The store does not own the pool. The database must be migrated by
 * `migrate()` or the CLI. Every lease, storage open and delete checks that, and throws `SchemaVersionError` when it is
 * not.
 */
export function createPostgresStore(pool: Pool, options?: PostgresStoreOptions): PostgresStore {
  return createStore(drizzle({ client: pool }), options);
}

/**
 * Creates or upgrades the runtime's tables with the migrations this package ships, in one transaction, on one
 * connection of `pool`. A session advisory lock on that connection serializes concurrent `migrate()` calls. Throws
 * `SchemaVersionError` for a database a newer release migrated, and changes nothing.
 */
export async function migrate(pool: Pool): Promise<MigrateResult> {
  const client = await pool.connect();
  // A dead connection emits `error` on its client. Without a listener, Node exits.
  const ignore = () => undefined;
  client.on("error", ignore);
  try {
    const result = await migrateOn(drizzle({ client }));
    client.off("error", ignore);
    client.release();
    return result;
  } catch (error) {
    // If its unlock failed, the connection may still hold the advisory lock, so it is destroyed, not returned to the
    // pool.
    client.release(true);
    throw error;
  }
}

/**
 * Throws `SchemaVersionError` unless the database is migrated to exactly this package's migrations. It costs one round
 * trip.
 */
export function checkSchema(pool: Pool): Promise<void> {
  return checkSchemaOf(drizzle({ client: pool }));
}
