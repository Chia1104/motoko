/**
 * `@chia1104/motoko-store-mysql`: Motoko's store on MySQL 8.0.24 or later, through Drizzle (mysql2). Many agent instances
 * (scopes) share one fixed set of `agent_runtime_*` tables in the pool's database; each gets a pi-durable `Storage`
 * fenced by a single-writer row lease.
 *
 * ```ts
 * const pool = mysql.createPool({ uri: connectionString });
 * await migrate(pool); // or the `motoko-store-mysql` CLI at deploy time
 * const store = createMysqlStore(pool);
 * // `nodeHost` of `@chia1104/motoko-node` makes the store the host of a long-lived process.
 * const runtime = createAgentRuntime({ agents, host: nodeHost(store), models, ports });
 * ```
 *
 * The Drizzle tables are at `@chia1104/motoko-store-mysql/schema`.
 */

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
// The shared-database store's errors are the core's, so `instanceof` holds across every such store.
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
 * The store over `pool` (mysql2's promise pool; a callback pool's `.promise()`): the runtime's store on the runtime's
 * tables (`nodeHost(store)` is its host), and `store.deleteScope` of any scope. The store does not own the pool. The
 * database must be migrated (`migrate()` or the CLI); every lease, storage open and delete checks it
 * (`SchemaVersionError`).
 *
 * The pool must be created with `multipleStatements: true`, or this throws a `TypeError`: the store sends each of its
 * transactions as one multi-statement query. Give the store a pool of its own (see the README).
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
 * Creates or upgrades the runtime's tables with the migrations this package ships, on one connection of `pool` that a
 * named lock (`GET_LOCK`) serializes against concurrent `migrate()` calls on the same database. MySQL commits each
 * DDL statement by itself: a migration that fails part way leaves its earlier statements applied. Refuses
 * (`SchemaVersionError`, nothing changed) a database a newer release migrated.
 */
export async function migrate(pool: Pool): Promise<MigrateResult> {
  const connection = await pool.getConnection();
  try {
    const result = await migrateOn(drizzle({ client: connection }));
    connection.release();
    return result;
  } catch (error) {
    // The connection may still hold the named lock (its release failed): destroy it rather than pool it.
    connection.destroy();
    throw error;
  }
}

/** Throws `SchemaVersionError` unless the database is migrated to exactly this package's migrations. One round trip. */
export function checkSchema(pool: Pool): Promise<void> {
  return checkSchemaOf(drizzle({ client: pool }));
}
