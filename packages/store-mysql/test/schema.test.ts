import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId, StorageWrite, TaskId } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  checkSchema,
  createMysqlStore,
  LeaseHeldError,
  migrate,
  MIGRATIONS_TABLE,
  SchemaVersionError,
  supportedMigrations,
} from "../src/index.ts";
import { stateOf } from "../src/migrations.ts";
import { scopes } from "../src/schema.ts";

import { MYSQL_URL, mysqlBackend, newPool, temporaryDatabase, uniqueName } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const DRIZZLE_KIT = join(PACKAGE, "node_modules", "drizzle-kit", "bin.js");
const context = BACKGROUND_CONTEXT;
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

const cli = (env: Record<string, string>, args: string[] = []) =>
  run(process.execPath, ["--conditions=@chia1104/motoko-source", "src/cli.ts", ...args], {
    cwd: PACKAGE,
    env: { PATH: process.env.PATH ?? "", ...env },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );

describe("the shipped migrations", () => {
  it("are the SQL drizzle-kit generates from the schema module: no pending diff", async () => {
    const out = await mkdtemp(join(tmpdir(), "agent-runtime-mysql-migrations-"));
    try {
      await cp(join(PACKAGE, "migrations"), out, { recursive: true });
      const before = await readdir(out);
      const { stdout } = await run(
        process.execPath,
        [DRIZZLE_KIT, "generate", "--dialect", "mysql", "--schema", "./src/schema.ts", "--out", out],
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

  it("compare a journal with the shipped list as sets", () => {
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

describe("the CLI without a database", () => {
  it("exits 2 with its usage when no connection string or an unknown command is given", async () => {
    expect(await cli({})).toMatchObject({ code: 2, stderr: expect.stringContaining("AGENT_RUNTIME_DATABASE_URL") });
    expect(await cli({ DATABASE_URL: "mysql://localhost/x" }, ["drop"])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Usage"),
    });
  });
});

describe.skipIf(MYSQL_URL === undefined)("migrations and the version check on MySQL", () => {
  let database: { url: string; drop(): Promise<void> };
  let pool: Pool;
  beforeEach(async () => {
    database = await temporaryDatabase(MYSQL_URL as string);
    pool = newPool(database.url, 2);
  });
  afterEach(async () => {
    await pool.end();
    await database.drop();
  });

  it("refuses an unmigrated database, with a clear error", async () => {
    const store = createMysqlStore(pool);
    const missing = await refusal(store.lease(scope));
    expect(missing.state).toBe("missing");
    expect(missing.applied).toEqual([]);
    expect(missing.message).toContain("no Motoko tables: run migrate()");
    await refusal(store.deleteScope(scope));
    await pool.query(
      `CREATE TABLE ${MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT, name TEXT)`,
    );
    expect((await refusal(checkSchema(pool))).state).toBe("missing");
    expect((await refusal(store.lease(scope))).state).toBe("missing");
  });

  it("migrates once, idempotently, beside the app's own tables, and then opens", async () => {
    await pool.query("CREATE TABLE app_users (id INT PRIMARY KEY)");
    expect(await migrate(pool)).toEqual({ applied: supportedMigrations() });
    expect(await migrate(pool)).toEqual({ applied: [] });
    await checkSchema(pool);
    const [tables] = await pool.query(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1",
    );
    expect((tables as { name: string }[]).map((table) => table.name)).toEqual([
      "agent_runtime_conversations",
      "agent_runtime_document_revisions",
      "agent_runtime_documents",
      "agent_runtime_entries",
      MIGRATIONS_TABLE,
      "agent_runtime_record_ids",
      "agent_runtime_scopes",
      "agent_runtime_submissions",
      "agent_runtime_tasks",
      "app_users",
    ]);
    const store = createMysqlStore(pool);
    const lease = await store.lease(scope);
    const storage = await store.storage(scope, lease);
    expect(await storage.mintId()).toBe(2);
    await lease.release();
  });

  it("refuses tables its journal does not hold, whose tables lack what its statements name", async () => {
    await migrate(pool);
    await pool.query("ALTER TABLE agent_runtime_scopes DROP COLUMN commit_nonce");
    await pool.query(`DELETE FROM ${MIGRATIONS_TABLE}`);
    const store = createMysqlStore(pool);
    expect((await refusal(store.lease(scope))).state).toBe("missing");
    expect((await refusal(store.deleteScope(scope))).state).toBe("missing");
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM agent_runtime_scopes");
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("refuses a database a newer release migrated, at open and in migrate(), changing nothing", async () => {
    await migrate(pool);
    const store = createMysqlStore(pool);
    const held = await store.lease(scope);
    await pool.query(`INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at, name) VALUES ('x', 0, ?)`, [
      "29991231000000_from_the_future",
    ]);
    expect((await refusal(store.storage(scope, held))).state).toBe("newer");
    expect((await refusal(store.deleteScope(scope, held))).state).toBe("newer");
    await held.release();
    const newer = await refusal(store.lease(scope));
    expect(newer.state).toBe("newer");
    expect(newer.applied).toEqual([...supportedMigrations(), "29991231000000_from_the_future"]);
    expect(newer.message).toContain("migrated by a newer release (29991231000000_from_the_future)");
    expect(newer.message).toContain("upgrade @chia1104/motoko-store-mysql");
    expect((await refusal(migrate(pool))).state).toBe("newer");
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${MIGRATIONS_TABLE}`);
    expect((rows as { n: number }[])[0]?.n).toBe(supportedMigrations().length + 1);
  });

  it("migrates a fresh database with migrate(), serializing concurrent calls", async () => {
    const pools = [newPool(database.url, 1), newPool(database.url, 1), newPool(database.url, 1)];
    try {
      await expect(checkSchema(pools[0] as Pool)).rejects.toThrow(SchemaVersionError);
      const results = await Promise.all(pools.map((one) => migrate(one)));
      expect(results.map((result) => result.applied.length).sort()).toEqual([0, 0, supportedMigrations().length]);
      for (const one of pools) await checkSchema(one);
    } finally {
      for (const one of pools) await one.end();
    }
  });

  it("migrates a fresh database with the CLI, from AGENT_RUNTIME_DATABASE_URL or DATABASE_URL", async () => {
    const unmigrated = await cli({ DATABASE_URL: database.url }, ["check"]);
    expect(unmigrated.code).toBe(1);
    expect(unmigrated.stderr).toContain("run migrate()");
    const first = await cli({
      AGENT_RUNTIME_DATABASE_URL: database.url,
      DATABASE_URL: "mysql://nowhere.invalid/none",
    });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`Applied ${supportedMigrations().length} migration(s)`);
    expect(first.stdout).toContain(latest);
    expect(first.stdout).not.toContain(":pw@");
    const second = await cli({ DATABASE_URL: database.url });
    expect(second).toMatchObject({ code: 0, stdout: expect.stringContaining("up to date") });
    expect(await cli({ DATABASE_URL: database.url }, ["check"])).toMatchObject({ code: 0 });
    await checkSchema(pool);
  });
});

describe.skipIf(MYSQL_URL === undefined)("what the tables keep on MySQL", () => {
  let backend: Backend;
  beforeAll(async () => {
    backend = await mysqlBackend(MYSQL_URL as string);
  });
  afterAll(async () => {
    await backend?.close();
  });

  it("keys a scope by the SHA-256 of its kind and name, up to 1024 four-byte characters each", async () => {
    const long = { kind: "𝒦".repeat(1024), name: "😀".repeat(1024) };
    const spaced = { kind: "agent", name: uniqueName("pad") };
    const scopes = [long, spaced, { ...spaced, name: `${spaced.name} ` }, { ...spaced, name: `${spaced.name}́` }];
    const leases = [];
    for (const each of scopes) leases.push(await backend.store.lease(each));
    expect(new Set(leases.map((lease) => lease.scopeId)).size).toBe(scopes.length);
    const [row] = await backend.query<{ kind: string; name: string; key: string }>(
      "SELECT kind, name, HEX(scope_key) AS `key` FROM agent_runtime_scopes WHERE scope_id = ?",
      [leases[0]?.scopeId],
    );
    expect(row).toEqual({
      ...long,
      key: createHash("sha256")
        .update(Buffer.concat([Buffer.from(long.kind), Buffer.from([0]), Buffer.from(long.name)]))
        .digest("hex")
        .toUpperCase(),
    });
    for (const lease of leases) await lease.release({ active: true });
    const listed = [];
    for await (const each of backend.store.unfinished()) listed.push(each);
    for (const each of scopes) expect(listed).toContainEqual(each);
    for (const lease of leases) expect(await backend.store.deleteScope(lease.scope)).toBe(true);
  });

  it("stores records losslessly: lone surrogates, NUL, astral characters, and more than TEXT's 64 KB", async () => {
    const lease = await backend.store.lease({ kind: "agent", name: uniqueName("records") });
    const storage = await backend.store.storage(lease.scope, lease);
    const data = { odd: '\ud800 \udfff \u0000 😀 \\ "', big: "x".repeat(200_000) };
    const id = (await storage.mintId()) as EntryId;
    await commitWrites(
      storage,
      [
        { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
        { type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "note", data } },
      ],
      context,
    );
    expect((await storage.entry(id, context))?.entry.data).toEqual(data);
    await lease.release();
  });

  it("compares indexed strings byte for byte", async () => {
    const lease = await backend.store.lease({ kind: "agent", name: uniqueName("bytes") });
    const storage = await backend.store.storage(lease.scope, lease);
    await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
    const kinds = ["a", "a ", "A", "á", "á", "ä"];
    for (const kind of kinds) {
      await commitWrites(
        storage,
        [
          {
            type: "task",
            value: {
              id: (await storage.mintId()) as TaskId<JsonValue>,
              conversationId: ROOT_CONVERSATION_ID,
              kind,
              version: 1,
              input: null,
              state: { status: "pending", checkpoint: null },
              background: false,
              abortRequested: false,
            },
          },
        ],
        context,
      );
    }
    for (const kind of kinds) {
      const found = await storage.scanTasks({ kind }, 10, undefined, context);
      expect(found.items.map((task) => task.kind)).toEqual([kind]);
    }
    await lease.release();
  });

  it("keeps integers up to 2^53", async () => {
    const scope = { kind: "agent", name: uniqueName("ints") };
    const lease = await backend.store.lease(scope);
    const storage = await backend.store.storage(scope, lease);
    await commitWrites(
      storage,
      [
        { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
        {
          type: "entry",
          value: { id: Number.MAX_SAFE_INTEGER as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: "last" },
        },
      ],
      context,
    );
    const [row] = await backend.query<{ next_id: string }>(
      "SELECT CAST(next_id AS CHAR) AS next_id FROM agent_runtime_scopes WHERE scope_id = ?",
      [lease.scopeId],
    );
    expect(row?.next_id).toBe(String(2 ** 53));
    await lease.release();
    const again = await backend.store.lease(scope);
    const reopened = await backend.store.storage(scope, again);
    expect((await reopened.entry(Number.MAX_SAFE_INTEGER as EntryId, context))?.entry.kind).toBe("last");
    await expect(reopened.mintId()).rejects.toThrow("ID space is exhausted");
    await again.release();
  });

  it("walks a fork chain deeper than MySQL's default recursion limit of 1000", async () => {
    const lease = await backend.store.lease({ kind: "agent", name: uniqueName("deep") });
    const storage = await backend.store.storage(lease.scope, lease);
    const rootEntry = (await storage.mintId()) as EntryId;
    await commitWrites(
      storage,
      [
        { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
        { type: "entry", value: { id: rootEntry, conversationId: ROOT_CONVERSATION_ID, kind: "root" } },
      ],
      context,
    );
    let parent = ROOT_CONVERSATION_ID;
    const forks: StorageWrite[] = [];
    for (let depth = 0; depth < 1_200; depth++) {
      const id = (await storage.mintId()) as ConversationId;
      forks.push({ type: "conversation", value: { id, parent: { conversationId: parent, at: rootEntry } } });
      parent = id;
    }
    await commitWrites(storage, forks, context);
    const page = await storage.scanEntries({ conversationId: parent }, 10, undefined, context);
    expect(page.items.map((entry) => entry.kind)).toEqual(["root"]);
    expect((await storage.entry(parent, rootEntry, context))?.entry.kind).toBe("root");
    await lease.release();
  });

  it("expires leases by the database clock in UTC, whatever the session's time zone", async () => {
    const pool = newPool(backend.url, 2);
    pool.pool.on("connection", (connection) => {
      connection.query("SET time_zone = '+14:00'");
    });
    try {
      const shifted = createMysqlStore(pool, { ttlMs: 60_000, holder: "far-east" });
      const scope = { kind: "agent", name: uniqueName("utc") };
      const lease = await shifted.lease(scope);
      const held = await backend.store.lease(scope).catch((error: unknown) => error);
      expect(held).toBeInstanceOf(LeaseHeldError);
      const expiresAt = (held as LeaseHeldError).expiresAt?.getTime() ?? 0;
      expect(Math.abs(expiresAt - (Date.now() + 60_000))).toBeLessThan(5_000);
      const [row] = await drizzle({ client: pool })
        .select({ expiresAt: scopes.leaseExpiresAt })
        .from(scopes)
        .where(eq(scopes.scopeId, lease.scopeId));
      expect(row?.expiresAt?.getTime()).toBe(expiresAt);
      await lease.release();
    } finally {
      await pool.end();
    }
  });
});
