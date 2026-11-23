/**
 * `@chia1104/motoko-store-postgres/pglite`: the same store on PGlite (in-process WASM Postgres), through Drizzle's PGlite
 * driver, for tests and local development. A separate entry, so the root never loads PGlite.
 *
 * PGlite is one connection: it serializes every statement, so the cross-connection behaviour of a real server
 * (concurrent writers, a lease holder's connection dying) cannot be observed on it.
 */

import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { checkSchemaOf, migrateOn } from "./migrations.ts";
import type { MigrateResult } from "./migrations.ts";
import { createStore } from "./store.ts";
import type { PostgresStore, PostgresStoreOptions } from "./store.ts";

export type { MigrateResult } from "./migrations.ts";
export type { PostgresStore, PostgresStoreOptions } from "./store.ts";

/** The store over a PGlite instance, which it does not own. See the root export's `createPostgresStore`. */
export function createPostgresStore(pglite: PGlite, options?: PostgresStoreOptions): PostgresStore {
  return createStore(drizzle({ client: pglite }), options);
}

/** Creates or upgrades the runtime's tables in `pglite`. See the root export's `migrate`. */
export function migrate(pglite: PGlite): Promise<MigrateResult> {
  return migrateOn(drizzle({ client: pglite }));
}

/** Throws `SchemaVersionError` unless `pglite` is migrated to exactly this package's migrations. */
export function checkSchema(pglite: PGlite): Promise<void> {
  return checkSchemaOf(drizzle({ client: pglite }));
}
