import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { asConnectionDatabase } from "./database.ts";
import { checkSchemaOf, migrateOn } from "./migrations.ts";
import type { MigrateResult } from "./migrations.ts";
import { createStore } from "./store.ts";
import type { PostgresStore, PostgresStoreOptions } from "./store.ts";

export type { MigrateResult } from "./migrations.ts";
export type { PostgresStore, PostgresStoreOptions } from "./store.ts";

/**
 * Creates the store over a PGlite instance, which the store does not own. See the root export's `createPostgresStore`.
 */
export function createPostgresStore(pglite: PGlite, options?: PostgresStoreOptions): PostgresStore {
  return createStore(drizzle({ client: pglite }), options);
}

/** Creates or upgrades the runtime's tables in `pglite`. See the root export's `migrate`. */
export function migrate(pglite: PGlite): Promise<MigrateResult> {
  return migrateOn(asConnectionDatabase(drizzle({ client: pglite })));
}

/** Throws `SchemaVersionError` unless `pglite` is migrated to exactly this package's migrations. */
export function checkSchema(pglite: PGlite): Promise<void> {
  return checkSchemaOf(drizzle({ client: pglite }));
}
