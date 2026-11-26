import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import type { Server, Socket } from "node:net";

import { drizzle } from "drizzle-orm/mysql2";
import type { MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type { Pool, PoolConnection } from "mysql2/promise";

import { createMysqlStore, migrate } from "../src/index.ts";
import type { MysqlStore, MysqlStoreOptions } from "../src/index.ts";

export const MYSQL_URL = process.env.TEST_MYSQL_URL;

export const uniqueName = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;

const textOf = (first: unknown): string =>
  typeof first === "string" ? first : String((first as { sql?: unknown }).sql);

/** Drizzle sends each statement as one `query()` call. */
export class Recording {
  readonly statements: string[] = [];
  before: ((sql: string) => void | Promise<void>) | undefined;
  after: ((sql: string) => void | Promise<void>) | undefined;
  readonly client: Pool;
  constructor(inner: Pool) {
    this.client = this.#wrap(inner);
  }
  reset(): void {
    this.statements.length = 0;
  }
  #wrap<C extends Pool | PoolConnection>(inner: C): C {
    return new Proxy(inner, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "getConnection") {
          return async () => this.#wrap(await (value as () => Promise<PoolConnection>).call(target));
        }
        if (property !== "query") return value.bind(target);
        return async (...args: unknown[]) => {
          const text = textOf(args[0]);
          this.statements.push(text);
          await this.before?.(text);
          const result: unknown = await value.apply(target, args);
          await this.after?.(text);
          return result;
        };
      },
    });
  }
}

export type AppDatabase = MySql2Database;

export interface Backend {
  readonly name: "MySQL";
  readonly store: MysqlStore;
  storeWith(options: MysqlStoreOptions): MysqlStore;
  recording(options?: MysqlStoreOptions): { store: MysqlStore; recording: Recording };
  query<Row extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<Row[]>;
  readonly app: AppDatabase;
  readonly url: string;
  close(): Promise<void>;
}

export function newPool(url: string, max = 4, program?: string): Pool {
  return mysql.createPool({
    uri: url,
    connectionLimit: max,
    multipleStatements: true,
    ...(program === undefined ? {} : { connectAttributes: { program_name: program } }),
  });
}

export async function temporaryDatabase(url: string): Promise<{ url: string; drop(): Promise<void> }> {
  const name = uniqueName("agent_runtime_test");
  const admin = await mysql.createConnection({ uri: url });
  try {
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  } finally {
    await admin.end();
  }
  const own = new URL(url);
  own.pathname = `/${name}`;
  return {
    url: own.toString(),
    async drop() {
      const client = await mysql.createConnection({ uri: url });
      try {
        await client.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await client.end();
      }
    },
  };
}

export async function mysqlBackend(url: string): Promise<Backend> {
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
    name: "MySQL",
    store: createMysqlStore(pool),
    storeWith: (options) => createMysqlStore(pool, options),
    recording(options) {
      const recording = new Recording(pool);
      return { store: createMysqlStore(recording.client, options), recording };
    },
    async query<Row extends Record<string, unknown>>(text: string, params: unknown[] = []) {
      const [rows] = await pool.query(text, params);
      return rows as Row[];
    },
    app: drizzle({ client: pool }),
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

export const backendFactories: readonly { name: string; open: () => Promise<Backend>; skip: boolean }[] = [
  { name: "MySQL", open: () => mysqlBackend(MYSQL_URL as string), skip: MYSQL_URL === undefined },
];

export const connectionReset = (): Error => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

export const statementsOf = (text: string | undefined): string[] =>
  (text ?? "").split(";\n").map((statement) => statement.trim());

export const statements = {
  commitRead: /^SELECT s\.next_id/,
  commitWrite: /^START TRANSACTION;\nUPDATE `agent_runtime_scopes` SET next_seq/,
  documentRead: /^SELECT d\.record/,
} as const;

const writeStatements = {
  guard: /^UPDATE `agent_runtime_scopes` SET next_seq/,
  insert: /^INSERT INTO `agent_runtime_([a-z_]+)`/,
  deleteRevisions: /^DELETE FROM `agent_runtime_document_revisions`/,
  outcome: /^SELECT CASE WHEN s\.scope_id IS NULL THEN 'deleted'/,
} as const;

export function kindOf(text: string): string | undefined {
  return Object.entries(statements).find(([, pattern]) => pattern.test(text))?.[0];
}

export function writeOf(text: string | undefined): (string | undefined)[] {
  const [first, ...inner] = statementsOf(text);
  const last = inner.pop();
  if (first !== "START TRANSACTION" || last !== "COMMIT") throw new Error(`Not a transaction: ${text}`);
  return inner.map((statement) => {
    const insert = writeStatements.insert.exec(statement);
    if (insert !== null) return `insert ${insert[1]}`;
    return Object.entries(writeStatements).find(([, pattern]) => pattern.test(statement))?.[0];
  });
}

export const forceExpire = (backend: Backend, scope: { kind: string; name: string }): Promise<unknown> =>
  backend.query(
    `UPDATE agent_runtime_scopes SET lease_expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND
      WHERE scope_key = UNHEX(SHA2(CONCAT(?, X'00', ?), 256))`,
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
