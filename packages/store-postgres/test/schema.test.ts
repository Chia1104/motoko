import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  checkSchema,
  migrate,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  SchemaVersionError,
  supportedMigrations,
} from "../src/index.ts";
import { stateOf } from "../src/migrations.ts";
import {
  checkSchema as checkPGlite,
  createPostgresStore as createPGliteStore,
  migrate as migratePGlite,
} from "../src/pglite.ts";

import { DATABASE_URL, newPool, temporaryDatabase } from "./helpers.ts";

const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DRIZZLE_KIT = join(PACKAGE, "node_modules", "drizzle-kit", "bin.js");
const scope = { kind: "agent", name: "one" };
const latest = supportedMigrations().at(-1) as string;

const refusal = async (promise: Promise<unknown>): Promise<SchemaVersionError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SchemaVersionError);
  return error as SchemaVersionError;
};

describe("the shipped migrations", () => {
  it("are the SQL drizzle-kit generates from the schema module: no pending diff", async () => {
    const out = await mkdtemp(join(tmpdir(), "agent-runtime-migrations-"));
    try {
      await cp(join(PACKAGE, "migrations"), out, { recursive: true });
      const before = await readdir(out);
      const { stdout } = await run(
        process.execPath,
        [DRIZZLE_KIT, "generate", "--dialect", "postgresql", "--schema", "./src/schema.ts", "--out", out],
        { cwd: PACKAGE },
      );
      expect(stdout).toMatch(/No schema changes/);
      expect(await readdir(out)).toEqual(before);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("are listed by name in the module the version check reads instead of the files", async () => {
    const folders = (await readdir(join(PACKAGE, "migrations"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(supportedMigrations()).toEqual(folders);
  });

  it("are folders of `migration.sql` that the package ships", () => {
    expect(supportedMigrations().length).toBeGreaterThan(0);
    for (const name of supportedMigrations()) expect(name).toMatch(/^\d{14}_[a-z0-9_]+$/);
  });
});

describe("migrations and the version check on PGlite", () => {
  let pglite: PGlite;
  beforeEach(async () => {
    pglite = await PGlite.create();
  });
  afterEach(async () => {
    await pglite.close();
  });

  it("refuses an unmigrated database, with a clear error", async () => {
    const store = createPGliteStore(pglite);
    const missing = await refusal(store.lease(scope));
    expect(missing.state).toBe("missing");
    expect(missing.applied).toEqual([]);
    expect(missing.message).toContain("no Motoko tables: run migrate()");
    await refusal(store.deleteScope(scope));
    await pglite.exec(`CREATE SCHEMA ${MIGRATIONS_SCHEMA}`);
    expect((await refusal(checkPGlite(pglite))).state).toBe("missing");
  });

  it("migrates once, idempotently, into the fixed schemas, and then opens", async () => {
    expect(await migratePGlite(pglite)).toEqual({ applied: supportedMigrations() });
    expect(await migratePGlite(pglite)).toEqual({ applied: [] });
    await checkPGlite(pglite);
    const tables = await pglite.query<{ schema: string; table: string }>(
      `SELECT table_schema AS schema, table_name AS table FROM information_schema.tables
        WHERE table_schema IN ('agent_runtime', '${MIGRATIONS_SCHEMA}') ORDER BY 1, 2`,
    );
    expect(tables.rows).toEqual([
      ...[
        "conversations",
        "document_revisions",
        "documents",
        "entries",
        "record_ids",
        "scopes",
        "submissions",
        "tasks",
      ].map((table) => ({ schema: "agent_runtime", table })),
      { schema: MIGRATIONS_SCHEMA, table: MIGRATIONS_TABLE },
    ]);
    const store = createPGliteStore(pglite);
    const lease = await store.lease(scope);
    const storage = await store.storage(scope, lease);
    expect(await storage.mintId()).toBe(2);
    await lease.release();
  });

  it("refuses a database a newer release migrated, at open and in migrate(), changing nothing", async () => {
    await migratePGlite(pglite);
    const store = createPGliteStore(pglite);
    const held = await store.lease(scope);
    await pglite.query(
      `INSERT INTO ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} (hash, created_at, name) VALUES ('x', 0, $1)`,
      ["29991231000000_from_the_future"],
    );
    expect((await refusal(store.storage(scope, held))).state).toBe("newer");
    expect((await refusal(store.deleteScope(scope, held))).state).toBe("newer");
    await held.release();
    const newer = await refusal(store.lease(scope));
    expect(newer.state).toBe("newer");
    expect(newer.applied).toEqual([...supportedMigrations(), "29991231000000_from_the_future"]);
    expect(newer.message).toContain("migrated by a newer release (29991231000000_from_the_future)");
    expect(newer.message).toContain("upgrade @chia1104/motoko-store-postgres");
    expect((await refusal(migratePGlite(pglite))).state).toBe("newer");
    const { rows } = await pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`,
    );
    expect(rows[0]?.n).toBe(supportedMigrations().length + 1);
  });

  it("refuses a database older than this package", async () => {
    expect(stateOf([], [latest])).toBe("missing");
    expect(stateOf(["20260101000000_init"], ["20260101000000_init", "20260201000000_next"])).toBe("older");
    expect(stateOf(["20260101000000_init", "20260201000000_next"], ["20260101000000_init"])).toBe("newer");
    expect(stateOf([latest], [latest])).toBe("current");
    const older = new SchemaVersionError(
      "older",
      ["20260101000000_init"],
      ["20260101000000_init", "20260201000000_next"],
    );
    expect(older.message).toContain(
      "older than this package (20260101000000_init, it needs 20260201000000_next): run migrate()",
    );
  });
});

describe.skipIf(DATABASE_URL === undefined)("migrations on Postgres", () => {
  it("migrates a fresh database with migrate(), serializing concurrent calls", async () => {
    const database = await temporaryDatabase(DATABASE_URL as string);
    const first = newPool(database.url, 1);
    const pools = [first, newPool(database.url, 1), newPool(database.url, 1)];
    try {
      await expect(checkSchema(first)).rejects.toThrow(SchemaVersionError);
      const results = await Promise.all(pools.map((pool) => migrate(pool)));
      expect(results.map((result) => result.applied.length).sort()).toEqual([0, 0, supportedMigrations().length]);
      for (const pool of pools) await checkSchema(pool);
    } finally {
      for (const pool of pools) await pool.end();
      await database.drop();
    }
  });

  it("migrates a fresh database with the CLI, from AGENT_RUNTIME_DATABASE_URL or DATABASE_URL", async () => {
    const database = await temporaryDatabase(DATABASE_URL as string);
    const cli = (env: Record<string, string>, args: string[] = []) =>
      run(process.execPath, ["--conditions=@chia1104/motoko-source", "src/cli.ts", ...args], {
        cwd: PACKAGE,
        env: { PATH: process.env.PATH ?? "", ...env },
      }).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
    try {
      const unmigrated = await cli({ DATABASE_URL: database.url }, ["check"]);
      expect(unmigrated.code).toBe(1);
      expect(unmigrated.stderr).toContain("run migrate()");
      const first = await cli({
        AGENT_RUNTIME_DATABASE_URL: database.url,
        DATABASE_URL: "postgres://nowhere.invalid/none",
      });
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`Applied ${supportedMigrations().length} migration(s)`);
      expect(first.stdout).toContain(latest);
      const second = await cli({ DATABASE_URL: database.url });
      expect(second).toMatchObject({ code: 0, stdout: expect.stringContaining("up to date") });
      expect(await cli({ DATABASE_URL: database.url }, ["check"])).toMatchObject({ code: 0 });
      const pool = newPool(database.url, 1);
      try {
        await checkSchema(pool);
      } finally {
        await pool.end();
      }
    } finally {
      await database.drop();
    }
  });
});

describe("the CLI without a database", () => {
  it("exits 2 with its usage when no connection string or an unknown command is given", async () => {
    const cli = (env: Record<string, string>, args: string[] = []) =>
      run(process.execPath, ["--conditions=@chia1104/motoko-source", "src/cli.ts", ...args], {
        cwd: PACKAGE,
        env: { PATH: process.env.PATH ?? "", ...env },
      }).then(
        () => ({ code: 0, stderr: "" }),
        (error: { code: number; stderr: string }) => error,
      );
    expect(await cli({})).toMatchObject({ code: 2, stderr: expect.stringContaining("AGENT_RUNTIME_DATABASE_URL") });
    expect(await cli({ DATABASE_URL: "postgres://localhost/x" }, ["drop"])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Usage"),
    });
  });
});
