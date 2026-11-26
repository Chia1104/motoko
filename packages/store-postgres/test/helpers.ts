import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";

import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePGlite } from "drizzle-orm/pglite";
import pg from "pg";

import { createPostgresStore, migrate } from "../src/index.ts";
import type { PostgresStore, PostgresStoreOptions } from "../src/index.ts";
import { createPostgresStore as createPGliteStore, migrate as migratePGlite } from "../src/pglite.ts";

export const DATABASE_URL = process.env.TEST_DATABASE_URL;

export const uniqueName = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

/** Drizzle sends each statement as one `query()` call. */
export class Recording<C extends object> {
  readonly statements: string[] = [];
  before: ((sql: string) => void | Promise<void>) | undefined;
  after: ((sql: string) => void | Promise<void>) | undefined;
  readonly client: C;
  constructor(inner: C) {
    this.client = new Proxy(inner, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property !== "query") return value.bind(target);
        return async (...args: unknown[]) => {
          const first = args[0];
          const text = typeof first === "string" ? first : String((first as { text?: unknown }).text);
          this.statements.push(text);
          await this.before?.(text);
          const result: unknown = await value.apply(target, args);
          await this.after?.(text);
          return result;
        };
      },
    });
  }
  reset(): void {
    this.statements.length = 0;
  }
}

export type AppDatabase = PgAsyncDatabase<PgQueryResultHKT>;

export interface Backend {
  readonly name: "PGlite" | "Postgres";
  readonly store: PostgresStore;
  storeWith(options: PostgresStoreOptions): PostgresStore;
  recording(options?: PostgresStoreOptions): { store: PostgresStore; recording: Recording<object> };
  query<Row extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<Row[]>;
  readonly app: AppDatabase;
  readonly url?: string;
  close(): Promise<void>;
}

export async function pgliteBackend(): Promise<Backend> {
  const pglite = await PGlite.create();
  await migratePGlite(pglite);
  return {
    name: "PGlite",
    store: createPGliteStore(pglite),
    storeWith: (options) => createPGliteStore(pglite, options),
    recording(options) {
      const recording = new Recording(pglite);
      return { store: createPGliteStore(recording.client, options), recording };
    },
    async query<Row extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pglite.query<Row>(text, params)).rows;
    },
    app: drizzlePGlite({ client: pglite }),
    close: () => pglite.close(),
  };
}

export function newPool(url: string, max = 4, applicationName?: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    ...(applicationName === undefined ? {} : { application_name: applicationName }),
  });
  // An idle client whose connection dies emits `error` on the pool. Without a listener, Node exits.
  pool.on("error", () => undefined);
  return pool;
}

export async function temporaryDatabase(url: string): Promise<{ url: string; drop(): Promise<void> }> {
  const name = uniqueName("agent_runtime_test");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const own = new URL(url);
  own.pathname = `/${name}`;
  return {
    url: own.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

export async function postgresBackend(url: string): Promise<Backend> {
  const database = await temporaryDatabase(url);
  const pool = newPool(database.url);
  try {
    await migrate(pool);
  } catch (error) {
    await pool.end();
    await database.drop();
    throw error;
  }
  return {
    name: "Postgres",
    store: createPostgresStore(pool),
    storeWith: (options) => createPostgresStore(pool, options),
    recording(options) {
      const recording = new Recording(pool);
      return { store: createPostgresStore(recording.client, options), recording };
    },
    async query<Row extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pool.query<Row>(text, params)).rows;
    },
    app: drizzlePg({ client: pool }),
    url: database.url,
    async close() {
      try {
        await pool.end();
      } finally {
        await database.drop();
      }
    },
  };
}

export const backendFactories: readonly { name: string; open: () => Promise<Backend> }[] = [
  { name: "PGlite", open: () => pgliteBackend() },
  ...(DATABASE_URL === undefined ? [] : [{ name: "Postgres", open: () => postgresBackend(DATABASE_URL) }]),
];

export const connectionReset = (): Error => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

export const statements = {
  commitRead: /^SELECT "s"\."next_id"/,
  commitWrite: /^WITH guard AS/,
  documentRead: /^WITH b AS/,
  guardDiagnosis: /^select "lease_token", "lease_expires_at" > clock_timestamp\(\)/,
} as const;

export const forceExpire = (backend: Backend, scope: { kind: string; name: string }): Promise<unknown> =>
  backend.query(
    `UPDATE agent_runtime.scopes SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE kind = $1 AND name = $2`,
    [scope.kind, scope.name],
  );

export class FreezableProxy {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #frozen = false;
  readonly #held: (() => void)[] = [];
  readonly port: Promise<number>;
  constructor(targetHost: string, targetPort: number) {
    this.#server = createServer((client) => {
      const upstream = connect(targetPort, targetHost);
      for (const socket of [client, upstream]) {
        this.#sockets.add(socket);
        socket.on("error", () => undefined);
        socket.on("close", () => this.#sockets.delete(socket));
      }
      const forward = (to: Socket) => (data: Buffer) => {
        if (this.#frozen) this.#held.push(() => to.write(data));
        else to.write(data);
      };
      client.on("data", forward(upstream));
      upstream.on("data", forward(client));
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    this.port = new Promise((resolve) => {
      this.#server.listen(0, "127.0.0.1", () => {
        const address = this.#server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  }
  freeze(): void {
    this.#frozen = true;
  }
  thaw(): void {
    this.#frozen = false;
    for (const deliver of this.#held.splice(0)) deliver();
  }
  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await sleep(10);
  }
}
