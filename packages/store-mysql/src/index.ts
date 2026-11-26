import { drizzle } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";

import { checkSchemaOf, migrateOn } from "./migrations.ts";
import type { MigrateResult } from "./migrations.ts";
import { createStore } from "./store.ts";
import type { MysqlStore, MysqlStoreOptions } from "./store.ts";

export { isTransientError } from "./database.ts";
export {
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
export { INDEXED_LENGTHS } from "./schema.ts";
export type { MysqlStorage } from "./storage.ts";
export type { MysqlLease, MysqlStore, MysqlStoreOptions } from "./store.ts";

/**
 * Creates the store over `pool`, which is mysql2's promise pool or a callback pool's `.promise()`. It is the runtime's
 * store on the runtime's tables, whose host is `nodeHost(store)`, and it serves `store.deleteScope` for any scope. The
 * store does not own the pool. The database must be migrated by `migrate()` or the CLI. Every lease, storage open and
 * delete checks that, and throws `SchemaVersionError` when it is not.
 *
 * The pool must be created with `multipleStatements: true`, or this throws a `TypeError`, because the store sends each
 * of its transactions as one multi-statement query. Give the store a pool of its own, as the README says.
 */
export function createMysqlStore(pool: Pool, options?: MysqlStoreOptions): MysqlStore {
  // mysql2 keeps the options it resolved on the core pool, which its typings do not show.
  const resolved = (pool as { pool?: { config?: { connectionConfig?: { multipleStatements?: unknown } } } }).pool;
  if (!resolved?.config?.connectionConfig?.multipleStatements) {
    throw new TypeError(
      "createMysqlStore needs a mysql2 pool created with multipleStatements: true, and one of its own: the store sends each transaction as one multi-statement query",
    );
  }
  return createStore(drizzle({ client: pool }), options);
}

/**
 * Creates or upgrades the runtime's tables with the migrations this package ships, on one connection of `pool`. A named
 * lock, `GET_LOCK`, on that connection serializes concurrent `migrate()` calls on the same database. MySQL commits each
 * DDL statement by itself, so a migration that fails part way leaves its earlier statements applied. Throws
 * `SchemaVersionError` for a database a newer release migrated, and changes nothing.
 */
export async function migrate(pool: Pool): Promise<MigrateResult> {
  const connection = await pool.getConnection();
  try {
    const result = await migrateOn(drizzle({ client: connection }));
    connection.release();
    return result;
  } catch (error) {
    // If its release failed, the connection may still hold the named lock, so it is destroyed, not returned to the
    // pool.
    connection.destroy();
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
