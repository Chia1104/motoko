// Migrations: SQL files drizzle-kit generated from `schema.ts`, shipped in the package's `migrations/` folder, applied
// by Drizzle's migrator, which records each one in its journal table. The journal is a table of its own
// (`agent_runtime_migrations`), so it never meets an app's own Drizzle journal, and is the version check's source: a
// database is at this package's version when its journal holds exactly the migrations this package ships.

import { fileURLToPath } from "node:url";

import { inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { migrate as drizzleMigrate, mysqlTable, serial, text } from "drizzle-orm/mysql-core";

import { ER_BAD_FIELD_ERROR, ER_NO_SUCH_TABLE, errorNumber, rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import { SHIPPED_MIGRATIONS } from "./shipped.ts";

/** The journal table, as Drizzle's migrator creates it in the pool's database beside the runtime's tables. */
export const MIGRATIONS_TABLE = "agent_runtime_migrations";

/** The part of Drizzle's journal table the check reads. */
const journal = mysqlTable(MIGRATIONS_TABLE, {
  id: serial("id"),
  hash: text("hash").notNull(),
  name: text("name"),
});

/** `migrations/` beside `src/` and `dist/`: both are one level below the package root. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * The shipped SQL files, for `migrate()`. Throws when the folder is not beside the package's code (a bundled copy) or
 * does not hold exactly `SHIPPED_MIGRATIONS`.
 */
function shippedMigrations(): MigrationMeta[] {
  let files: MigrationMeta[];
  try {
    files = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  } catch (cause) {
    throw new Error(
      `The migration files are not at ${MIGRATIONS_FOLDER}: run migrate() or the motoko-store-mysql CLI from the installed package, not from a bundle`,
      { cause },
    );
  }
  const names = files.map((migration) => migration.name);
  if (names.length !== SHIPPED_MIGRATIONS.length || names.some((name, index) => name !== SHIPPED_MIGRATIONS[index])) {
    throw new Error(
      `The migration files (${names.join(", ")}) are not the ones this package lists (${SHIPPED_MIGRATIONS.join(", ")})`,
    );
  }
  return files;
}

/** The names (`<timestamp>_<tag>`) of the migrations this package ships, in order. Reads no file. */
export function supportedMigrations(): readonly string[] {
  return SHIPPED_MIGRATIONS;
}

export type SchemaState =
  /** No journal, or an empty one: the database was never migrated. */
  | "missing"
  /** Some migrations this package ships are not applied: `migrate()` applies them. */
  | "older"
  /** The journal holds migrations this package does not ship: a newer release migrated the database. */
  | "newer";

/** The database is not at this package's schema version. Nothing was changed. */
export class SchemaVersionError extends Error {
  readonly state: SchemaState;
  /** The migrations the journal holds; empty when it is missing. */
  readonly applied: readonly string[];
  /** The migrations this package ships. */
  readonly supported: readonly string[];
  constructor(state: SchemaState, applied: readonly string[], supported: readonly string[]) {
    const latest = supported.at(-1) ?? "none";
    super(
      state === "missing"
        ? `The database has no Motoko tables: run migrate()`
        : state === "older"
          ? `The Motoko tables are older than this package (${applied.at(-1)}, it needs ${latest}): run migrate()`
          : `The Motoko tables were migrated by a newer release (${applied.filter((name) => !supported.includes(name)).join(", ")}): upgrade @chia1104/motoko-store-mysql`,
    );
    this.name = "SchemaVersionError";
    this.state = state;
    this.applied = applied;
    this.supported = supported;
  }
}

/** The journal's migration names, or `undefined` when the journal table does not exist. */
async function readJournal(db: Database): Promise<string[] | undefined> {
  try {
    const rows = await db.select({ name: journal.name }).from(journal).orderBy(journal.id);
    // A row without a name predates Drizzle's v1 journal: no release of this package wrote one.
    return rows.map((row) => row.name ?? "<unnamed>");
  } catch (error) {
    if (errorNumber(error) === ER_NO_SUCH_TABLE) return undefined;
    throw error;
  }
}

/** @internal How `applied` (the journal) stands to `supported` (the shipped migrations); `undefined`: equal. */
export function stateOf(applied: readonly string[], supported: readonly string[]): SchemaState | undefined {
  if (applied.some((name) => !supported.includes(name))) return "newer";
  if (applied.length === 0) return "missing";
  if (supported.some((name) => !applied.includes(name))) return "older";
  return undefined;
}

/** Throws `SchemaVersionError` unless the database is migrated to exactly this package's migrations. One round trip. */
export async function checkSchemaOf(db: Database): Promise<void> {
  assertApplied((await readJournal(db)) ?? []);
}

/** Throws `SchemaVersionError` unless `applied` (the journal's names) is exactly this package's migrations. */
function assertApplied(applied: readonly string[]): void {
  const supported = supportedMigrations();
  const state = stateOf(applied, supported);
  if (state !== undefined) throw new SchemaVersionError(state, applied, supported);
}

/**
 * The version check folded into other statements, so a lease or a storage open costs no round trip of its own for
 * it: `applied` selects the journal's names as a JSON array (`NULL` when it is empty), which the statement's caller
 * passes to `assertCurrent`, and `current` is a condition that holds only while they are exactly this package's
 * migrations, for a statement that writes before its caller can check. Names start with their timestamp, so they sort
 * into the journal's order.
 */
export const journalCheck = {
  applied: sql`(SELECT JSON_ARRAYAGG(COALESCE(${journal.name}, '<unnamed>')) FROM ${journal})`,
  current: sql`(SELECT COUNT(*) = ${SHIPPED_MIGRATIONS.length}
      AND COUNT(DISTINCT CASE WHEN ${inArray(journal.name, [...SHIPPED_MIGRATIONS])} THEN ${journal.name} END)
        = ${SHIPPED_MIGRATIONS.length}
    FROM ${journal})`,
  /** Throws `SchemaVersionError` unless `applied`, as the statement read it, is this package's migrations. */
  assertCurrent(applied: unknown): void {
    const names = typeof applied === "string" ? (JSON.parse(applied) as unknown) : applied;
    assertApplied(Array.isArray(names) ? names.map(String).sort() : []);
  },
};

/**
 * Runs statements that read the journal themselves. Without a journal (never migrated) they fail on the missing table,
 * and on tables older than this package on a missing column; the separate check then gives the precise
 * `SchemaVersionError` instead of the driver's error.
 */
export async function withJournal<T>(db: Database, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const errno = errorNumber(error);
    if (errno === ER_NO_SUCH_TABLE || errno === ER_BAD_FIELD_ERROR) await checkSchemaOf(db);
    throw error;
  }
}

export interface MigrateResult {
  /** The migrations this call applied, in order; empty when the database was up to date. */
  readonly applied: readonly string[];
}

/** A named lock per database (names are server-wide and at most 64 characters). */
const LOCK: SQL = sql`CONCAT('agent_runtime_migrate:', MD5(DATABASE()))`;

/**
 * Applies the migrations the database lacks with Drizzle's migrator. MySQL commits each DDL statement by itself, so
 * a migration that fails part way leaves its earlier statements applied, and its journal row unwritten. Refuses a
 * database a newer release migrated. `db` must be bound to one connection: a named lock (`GET_LOCK`) on it serializes
 * concurrent `migrate()` calls on the same database, which Drizzle's migrator does not do by itself.
 */
export async function migrateOn(db: Database): Promise<MigrateResult> {
  const [locked] = await rowsOf<{ locked: unknown }>(db, sql`SELECT GET_LOCK(${LOCK}, -1) AS locked`);
  if (Number(locked?.locked) !== 1) throw new Error("Could not take the migration lock");
  let failed = false;
  try {
    const supported = supportedMigrations();
    const applied = (await readJournal(db)) ?? [];
    if (stateOf(applied, supported) === "newer") throw new SchemaVersionError("newer", applied, supported);
    const pending = supported.filter((name) => !applied.includes(name));
    if (pending.length === 0) return { applied: [] };
    await drizzleMigrate(shippedMigrations(), db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsTable: MIGRATIONS_TABLE,
    });
    return { applied: pending };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // After a failure the original error stands; a connection that cannot unlock is the caller's to destroy.
    await db.execute(sql`SELECT RELEASE_LOCK(${LOCK})`).catch((error: unknown) => {
      if (!failed) throw error;
    });
  }
}
