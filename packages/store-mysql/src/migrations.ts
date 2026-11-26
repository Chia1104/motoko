import { fileURLToPath } from "node:url";

import { inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { migrate as drizzleMigrate, mysqlTable, serial, text } from "drizzle-orm/mysql-core";

import { ER_BAD_FIELD_ERROR, ER_NO_SUCH_TABLE, errorNumber, rowsOf } from "./database.ts";
import type { ConnectionDatabase, Database } from "./database.ts";
import { SHIPPED_MIGRATIONS } from "./shipped.ts";

/** The journal table, as Drizzle's migrator creates it in the pool's database beside the runtime's tables. */
export const MIGRATIONS_TABLE = "agent_runtime_migrations";

const journal = mysqlTable(MIGRATIONS_TABLE, {
  id: serial("id"),
  hash: text("hash").notNull(),
  name: text("name"),
});

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

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

/** The names of the migrations this package ships, in order, each `<timestamp>_<tag>`. It reads no file. */
export function supportedMigrations(): readonly string[] {
  return SHIPPED_MIGRATIONS;
}

export type SchemaState =
  /** The journal is missing or empty, so the database was never migrated. */
  | "missing"
  /** Some migrations this package ships are not applied. `migrate()` applies them. */
  | "older"
  /** The journal holds migrations this package does not ship, because a newer release migrated the database. */
  | "newer";

/** The database is not at this package's schema version. Nothing was changed. */
export class SchemaVersionError extends Error {
  readonly state: SchemaState;
  /** The migrations the journal holds. It is empty when the journal is missing. */
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

async function readJournal(db: Database): Promise<string[] | undefined> {
  try {
    const rows = await db.select({ name: journal.name }).from(journal).orderBy(journal.id);
    return rows.map((row) => row.name ?? "<unnamed>");
  } catch (error) {
    if (errorNumber(error) === ER_NO_SUCH_TABLE) return undefined;
    throw error;
  }
}

export type JournalState = SchemaState | "current";

export function stateOf(applied: readonly string[], supported: readonly string[]): JournalState {
  if (applied.some((name) => !supported.includes(name))) return "newer";
  if (applied.length === 0) return "missing";
  if (supported.some((name) => !applied.includes(name))) return "older";
  return "current";
}

export async function checkSchemaOf(db: Database): Promise<void> {
  assertApplied((await readJournal(db)) ?? []);
}

function assertApplied(applied: readonly string[]): void {
  const supported = supportedMigrations();
  const state = stateOf(applied, supported);
  if (state !== "current") throw new SchemaVersionError(state, applied, supported);
}

export const journalCheck = {
  applied: sql`(SELECT JSON_ARRAYAGG(COALESCE(${journal.name}, '<unnamed>')) FROM ${journal})`,
  current: sql`(SELECT COUNT(*) = ${SHIPPED_MIGRATIONS.length}
      AND COUNT(DISTINCT CASE WHEN ${inArray(journal.name, [...SHIPPED_MIGRATIONS])} THEN ${journal.name} END)
        = ${SHIPPED_MIGRATIONS.length}
    FROM ${journal})`,
  assertCurrent(applied: unknown): void {
    const names = typeof applied === "string" ? (JSON.parse(applied) as unknown) : applied;
    const inTimestampOrder = Array.isArray(names) ? names.map(String).sort() : [];
    assertApplied(inTimestampOrder);
  },
};

export async function missingOrOlderSchemaAsVersionError<T>(db: Database, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const errno = errorNumber(error);
    if (errno === ER_NO_SUCH_TABLE || errno === ER_BAD_FIELD_ERROR) await checkSchemaOf(db);
    throw error;
  }
}

export interface MigrateResult {
  /** The migrations this call applied, in order. It is empty when the database was up to date. */
  readonly applied: readonly string[];
}

/** A named lock per database. Lock names are server-wide and at most 64 characters long. */
const LOCK: SQL = sql`CONCAT('agent_runtime_migrate:', MD5(DATABASE()))`;

export async function migrateOn(db: ConnectionDatabase): Promise<MigrateResult> {
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
    await db.execute(sql`SELECT RELEASE_LOCK(${LOCK})`).catch((error: unknown) => {
      if (!failed) throw error;
    });
  }
}
