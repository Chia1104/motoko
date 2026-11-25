import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { MySqlAsyncDatabase } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import type { MySql2QueryResultHKT } from "drizzle-orm/mysql2";
import type { ResultSetHeader } from "mysql2";
import type { Pool } from "mysql2/promise";

import { scopes } from "./schema.ts";

export type Database = MySqlAsyncDatabase<MySql2QueryResultHKT>;

export type PoolDatabase = Database & { readonly $client: Pool };

export type PacketResult = Record<string, unknown>[] | ResultSetHeader;

/**
 * MySQL stops at the first statement that fails and leaves the transaction open on that connection, with the statements
 * before it applied. So a connection a packet failed on is destroyed, never returned to the pool. The server rolls its
 * transaction back as the connection closes, and no later query runs inside that transaction, where the next
 * `START TRANSACTION` would commit it.
 */
export async function packet(db: PoolDatabase, statements: readonly SQL[]): Promise<PacketResult[]> {
  const connection = await db.$client.getConnection();
  try {
    const results = await drizzle({ client: connection }).execute(
      sql.join([sql`START TRANSACTION`, ...statements, sql`COMMIT`], sql`;\n`),
      "objects",
    );
    connection.release();
    return (results as unknown as PacketResult[]).slice(1, -1);
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

export function rowsOf<Row extends Record<string, unknown>>(db: Database, query: SQL): Promise<Row[]> {
  return db.execute<Row>(query, "objects");
}

export async function run(db: Database, query: SQL): Promise<ResultSetHeader> {
  const [header] = (await db.execute(query)) as unknown as [ResultSetHeader];
  return header;
}

export const now = sql`UTC_TIMESTAMP(3)`;

export const expiryIn = (ms: number): SQL => sql`UTC_TIMESTAMP(3) + INTERVAL ${Math.round(ms * 1000)} MICROSECOND`;

/**
 * A `DATETIME` in UTC as epoch ms, for `sql` statements, because mysql2 would decode the column in its own time zone.
 */
export const epochMs = (column: SQLWrapper): SQL =>
  sql`TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ${column}) DIV 1000`;

export const freshNonce = (): Buffer => randomBytes(16);

export const fenced = (scopeId: number, nonce: Buffer): SQL =>
  sql`EXISTS (SELECT 1 FROM ${scopes} AS fence WHERE fence.scope_id = ${scopeId} AND fence.commit_nonce = ${nonce})`;

export const scopeKey = (kind: string, name: string): SQL => sql`UNHEX(SHA2(CONCAT(${kind}, X'00', ${name}), 256))`;

/**
 * A hint for a statement whose recursive CTE walks a fork chain or an ownership tree, as deep as its data goes. MySQL's
 * default `cte_max_recursion_depth` would abort it after 1000 levels.
 */
export const UNBOUNDED = sql.raw("/*+ SET_VAR(cte_max_recursion_depth = 4294967295) */");

export const MAX_BIGINT = sql.raw("9223372036854775807");

/**
 * Returns `error` and its `cause` chain. Drizzle wraps a driver's error in a `DrizzleQueryError`, with the driver's
 * error as its `cause`.
 */
export function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && current !== null && chain.length < 8;) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

export function errorNumber(error: unknown): number | undefined {
  for (const link of causes(error)) {
    const errno = typeof link === "object" && link !== null ? (link as { errno?: unknown }).errno : undefined;
    if (typeof errno === "number") return errno;
  }
  return undefined;
}

export const ER_BAD_FIELD_ERROR = 1054;
export const ER_DUP_ENTRY = 1062;
export const ER_NO_SUCH_TABLE = 1146;

const ER_CON_COUNT_ERROR = 1040;
const ER_SERVER_SHUTDOWN = 1053;
const ER_LOCK_DEADLOCK = 1213;
const ER_QUERY_INTERRUPTED = 1317;
const CR_SERVER_GONE_ERROR = 2006;
const CR_SERVER_LOST = 2013;
const ER_CLIENT_INTERACTION_TIMEOUT = 4031;

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
]);

const TRANSIENT_ERRNOS = new Set([
  ER_CON_COUNT_ERROR,
  ER_SERVER_SHUTDOWN,
  ER_LOCK_DEADLOCK,
  ER_QUERY_INTERRUPTED,
  CR_SERVER_GONE_ERROR,
  CR_SERVER_LOST,
  ER_CLIENT_INTERACTION_TIMEOUT,
]);

const TRANSIENT_MESSAGE = /Connection lost|connection is in closed state|server closed the connection/i;

/**
 * True for a failure of the connection, not of the statement. The statement may then be retried if it is idempotent.
 */
export function isTransientError(error: unknown): boolean {
  for (const link of causes(error)) {
    if (typeof link !== "object" || link === null) continue;
    const { code, errno, fatal, message, name } = link as {
      code?: unknown;
      errno?: unknown;
      fatal?: unknown;
      message?: unknown;
      name?: unknown;
    };
    // mysql2 marks an error that ended the connection as fatal.
    if (fatal === true) return true;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    if (typeof errno === "number" && TRANSIENT_ERRNOS.has(errno)) return true;
    // A DrizzleQueryError's message is the failed statement's text, not the failure. Only its cause describes the
    // failure.
    if (name !== "DrizzleQueryError" && typeof message === "string" && TRANSIENT_MESSAGE.test(message)) return true;
  }
  return false;
}
