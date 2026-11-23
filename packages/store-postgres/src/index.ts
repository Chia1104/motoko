/**
 * `@chia1104/motoko-store-postgres`: Motoko's store on Postgres, through Drizzle (node-postgres). Many agent instances
 * (scopes) share one fixed set of tables in the `agent_runtime` schema; each gets a pi-durable `Storage` fenced by a
 * single-writer row lease.
 *
 * ```ts
 * const pool = new pg.Pool({ connectionString });
 * await migrate(pool); // or the `motoko-store-postgres` CLI at deploy time
 * const store = createPostgresStore(pool);
 * // `nodeHost` of `@chia1104/motoko-node` makes the store the host of a long-lived process.
 * const runtime = createAgentRuntime({ agents, host: nodeHost(store), models, ports });
 * ```
 *
 * PGlite is at `@chia1104/motoko-store-postgres/pglite`, the Drizzle tables at `@chia1104/motoko-store-postgres/schema`.
 */

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
// The shared-database store's errors are the core's, so `instanceof` holds across every such store.
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
 * The store over `pool`: the runtime's store on the runtime's tables (`nodeHost(store)` is its host), and
 * `store.deleteScope` of any scope. The store does not own the pool. The database must be migrated (`migrate()` or
 * the CLI); every lease, storage open and delete checks it (`SchemaVersionError`).
 */
export function createPostgresStore(pool: Pool, options?: PostgresStoreOptions): PostgresStore {
  return createStore(drizzle({ client: pool }), options);
}

/**
 * Creates or upgrades the runtime's tables with the migrations this package ships, in one transaction, on one connection
 * of `pool` that a session advisory lock serializes against concurrent `migrate()` calls. Refuses
 * (`SchemaVersionError`, nothing changed) a database a newer release migrated.
 */
export async function migrate(pool: Pool): Promise<MigrateResult> {
  const client = await pool.connect();
  // A dead connection emits `error` on its client; without a listener Node exits.
  const ignore = () => undefined;
  client.on("error", ignore);
  try {
    const result = await migrateOn(drizzle({ client }));
    client.off("error", ignore);
    client.release();
    return result;
  } catch (error) {
    // The connection may still hold the advisory lock (its unlock failed): destroy it rather than pool it.
    client.release(true);
    throw error;
  }
}

/** Throws `SchemaVersionError` unless the database is migrated to exactly this package's migrations. One round trip. */
export function checkSchema(pool: Pool): Promise<void> {
  return checkSchemaOf(drizzle({ client: pool }));
}
