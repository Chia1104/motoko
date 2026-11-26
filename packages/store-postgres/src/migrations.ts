import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { migrate as drizzleMigrate, pgSchema, serial, text } from "drizzle-orm/pg-core";

import { errorCode, INVALID_SCHEMA_NAME, UNDEFINED_TABLE } from "./database.ts";
import type { ConnectionDatabase, Database } from "./database.ts";
import { SHIPPED_MIGRATIONS } from "./shipped.ts";

/** The Postgres schema of the runtime's migrations journal. The runtime's tables are in `agent_runtime`. */
export const MIGRATIONS_SCHEMA = "agent_runtime_drizzle";
/** The journal table in `MIGRATIONS_SCHEMA`, as Drizzle's migrator creates it. */
export const MIGRATIONS_TABLE = "migrations";

const journal = pgSchema(MIGRATIONS_SCHEMA).table(MIGRATIONS_TABLE, {
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
      `The migration files are not at ${MIGRATIONS_FOLDER}: run migrate() or the motoko-store-postgres CLI from the installed package, not from a bundle`,
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
          : `The Motoko tables were migrated by a newer release (${applied.filter((name) => !supported.includes(name)).join(", ")}): upgrade @chia1104/motoko-store-postgres`,
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
    const code = errorCode(error);
    if (code === UNDEFINED_TABLE || code === INVALID_SCHEMA_NAME) return undefined;
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
  applied: sql`ARRAY(SELECT coalesce(${journal.name}, '<unnamed>') FROM ${journal} ORDER BY ${journal.id})`,
  current(applied: SQL): SQL {
    const supported = sql`${sql.param([...supportedMigrations()])}::text[]`;
    return sql`(cardinality(${applied}) > 0 AND ${applied} <@ ${supported} AND ${supported} <@ ${applied})`;
  },
  assertCurrent(applied: readonly string[] | null | undefined): void {
    assertApplied(applied ?? []);
  },
};

export async function missingJournalAsVersionError<T>(db: Database, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = errorCode(error);
    if (code === UNDEFINED_TABLE || code === INVALID_SCHEMA_NAME) await checkSchemaOf(db);
    throw error;
  }
}

export interface MigrateResult {
  /** The migrations this call applied, in order. It is empty when the database was up to date. */
  readonly applied: readonly string[];
}

const LOCK = sql`hashtext('agent-runtime-storage-postgres:migrate')`;

export async function migrateOn(db: ConnectionDatabase): Promise<MigrateResult> {
  await db.execute(sql`SELECT pg_advisory_lock(${LOCK})`);
  let failed = false;
  try {
    const supported = supportedMigrations();
    const applied = (await readJournal(db)) ?? [];
    if (stateOf(applied, supported) === "newer") throw new SchemaVersionError("newer", applied, supported);
    const pending = supported.filter((name) => !applied.includes(name));
    if (pending.length === 0) return { applied: [] };
    await drizzleMigrate(shippedMigrations(), db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
    return { applied: pending };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${LOCK})`).catch((error: unknown) => {
      if (!failed) throw error;
    });
  }
}
