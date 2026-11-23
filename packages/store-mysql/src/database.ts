// What the package runs on: a Drizzle MySQL database over a mysql2 pool, or over one of its connections. Query-builder
// statements decode their columns with Drizzle's codecs; for `sql` statements the rows come back as mysql2 decoded them
// (BIGINT as `number` or `string`, JSON parsed, DATETIME in the client's time zone), so integers go through `toNumber`,
// and no `sql` statement reads a DATETIME column: it reads the epoch ms instead (`epochMs`).

import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { MySqlAsyncDatabase } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import type { MySql2QueryResultHKT } from "drizzle-orm/mysql2";
import type { ResultSetHeader } from "mysql2";
import type { Pool } from "mysql2/promise";

import { scopes } from "./schema.ts";

/** A Drizzle MySQL database. Relations are unused: `any` is what Drizzle's migrator takes. */
export type Database = MySqlAsyncDatabase<MySql2QueryResultHKT, any>; // oxlint-disable-line typescript/no-explicit-any

/** The store's database: over a mysql2 pool that sends multi-statement queries, whose connections `packet` borrows. */
export type PoolDatabase = Database & { readonly $client: Pool };

/** What one statement of a packet resolved: a SELECT's rows, or what a write did. */
export type PacketResult = Record<string, unknown>[] | ResultSetHeader;

/**
 * Runs `statements` as one transaction in one round trip: `START TRANSACTION`, the statements and `COMMIT`, sent as one
 * multi-statement query on a connection of its own. Resolves each statement's result, in order.
 *
 * MySQL stops at the first statement that fails and leaves the transaction open on that connection, with the
 * statements before it applied. So a connection a packet failed on is destroyed, never returned to the pool: the
 * server rolls its transaction back as the connection closes, and no later query runs inside it, where the next
 * `START TRANSACTION` would commit it. The failure rejects as one statement's does: a transient one is an unknown
 * outcome, which the caller resolves as it would for a single statement.
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

/** Runs one `sql` statement (one round trip) and returns its rows as objects, as mysql2 decoded them. */
export function rowsOf<Row extends Record<string, unknown>>(db: Database, query: SQL): Promise<Row[]> {
  return db.execute<Row>(query, "objects");
}

/** Runs one `sql` statement that returns no rows (one round trip) and returns what it did. */
export async function run(db: Database, query: SQL): Promise<ResultSetHeader> {
  const [header] = (await db.execute(query)) as unknown as [ResultSetHeader];
  return header;
}

/** The database clock now, in UTC, whatever the session's `time_zone`. */
export const now = sql`UTC_TIMESTAMP(3)`;

/** `ms` after the database clock's now. */
export const expiryIn = (ms: number): SQL => sql`UTC_TIMESTAMP(3) + INTERVAL ${Math.round(ms * 1000)} MICROSECOND`;

/** A `DATETIME` in UTC as epoch ms, for `sql` statements: mysql2 would decode the column in its own time zone. */
export const epochMs = (column: SQLWrapper): SQL =>
  sql`TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ${column}) DIV 1000`;

/**
 * A fresh nonce for one fenced transaction. Its first statement stamps it on the scope's row (`commit_nonce`) only if
 * its conditions hold, such as the lease being current, and each later statement writes only where the row holds it
 * (`fenced`): none of them can pass on a first statement that did not apply, whoever wrote the row since.
 */
export const freshNonce = (): Buffer => randomBytes(16);

/** Holds only while scope `scopeId`'s row holds `nonce`: within the transaction whose first statement stamped it. */
export const fenced = (scopeId: number, nonce: Buffer): SQL =>
  sql`EXISTS (SELECT 1 FROM ${scopes} AS fence WHERE fence.scope_id = ${scopeId} AND fence.commit_nonce = ${nonce})`;

/** The unique key of a scope: the SHA-256 that `scopes.scope_key` generates from its kind and name. */
export const scopeKey = (kind: string, name: string): SQL => sql`UNHEX(SHA2(CONCAT(${kind}, X'00', ${name}), 256))`;

/**
 * A hint for a statement whose recursive CTE walks a fork chain or an ownership tree, as deep as its data: MySQL's
 * default `cte_max_recursion_depth` would abort it after 1000 levels.
 */
export const UNBOUNDED = sql.raw("/*+ SET_VAR(cte_max_recursion_depth = 4294967295) */");

/** The largest BIGINT: no seq is above it. */
export const MAX_BIGINT = sql.raw("9223372036854775807");

/** `error` and its `cause` chain: Drizzle wraps a driver's error in a `DrizzleQueryError` whose `cause` it is. */
export function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && current !== null && chain.length < 8;) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/** The first MySQL error number (`errno`) in `error`'s cause chain. */
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
  1040, // ER_CON_COUNT_ERROR: too many connections
  1053, // ER_SERVER_SHUTDOWN
  1213, // ER_LOCK_DEADLOCK: the server rolled the transaction back
  1317, // ER_QUERY_INTERRUPTED: the connection was killed mid-statement
  2006, // CR_SERVER_GONE_ERROR
  2013, // CR_SERVER_LOST
  4031, // ER_CLIENT_INTERACTION_TIMEOUT: the server closed an idle connection
]);

const TRANSIENT_MESSAGE = /Connection lost|connection is in closed state|server closed the connection/i;

/** A failure of the connection, not of the statement: the statement may be retried if it is idempotent. */
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
    // A DrizzleQueryError's message is the failed statement's text, not the failure: only its cause tells.
    if (name !== "DrizzleQueryError" && typeof message === "string" && TRANSIENT_MESSAGE.test(message)) return true;
  }
  return false;
}
