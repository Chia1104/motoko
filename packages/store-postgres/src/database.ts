import type { SQL } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type Database = PgAsyncDatabase<PgQueryResultHKT>;

/**
 * Runs one `sql` statement, one round trip, and returns its rows as objects, as the driver parsed them. int8 is a
 * `string` on node-postgres and a `number` on PGlite. Both drivers parse json and arrays.
 */
export function rowsOf<Row extends Record<string, unknown>>(db: Database, query: SQL): Promise<Row[]> {
  return db.execute<Row>(query, "objects");
}

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

export function errorCode(error: unknown): string | undefined {
  for (const link of causes(error)) {
    const code = typeof link === "object" && link !== null ? (link as { code?: unknown }).code : undefined;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export const UNDEFINED_TABLE = "42P01";
export const INVALID_SCHEMA_NAME = "3F000";

const ADMIN_SHUTDOWN = "57P01";
const CRASH_SHUTDOWN = "57P02";
const CANNOT_CONNECT_NOW = "57P03";
const TOO_MANY_CONNECTIONS = "53300";
const CONNECTION_EXCEPTION = "08000";
const SQLCLIENT_UNABLE_TO_ESTABLISH_SQLCONNECTION = "08001";
const CONNECTION_DOES_NOT_EXIST = "08003";
const SQLSERVER_REJECTED_ESTABLISHMENT_OF_SQLCONNECTION = "08004";
const CONNECTION_FAILURE = "08006";

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  ADMIN_SHUTDOWN,
  CRASH_SHUTDOWN,
  CANNOT_CONNECT_NOW,
  TOO_MANY_CONNECTIONS,
  CONNECTION_EXCEPTION,
  SQLCLIENT_UNABLE_TO_ESTABLISH_SQLCONNECTION,
  CONNECTION_DOES_NOT_EXIST,
  SQLSERVER_REJECTED_ESTABLISHMENT_OF_SQLCONNECTION,
  CONNECTION_FAILURE,
]);

const TRANSIENT_MESSAGE = /Connection terminated|connection error|Client was closed|terminating connection/i;

/**
 * True for a failure of the connection, not of the statement. The statement may then be retried if it is idempotent.
 */
export function isTransientError(error: unknown): boolean {
  for (const link of causes(error)) {
    if (typeof link !== "object" || link === null) continue;
    const { code, message, name } = link as { code?: unknown; message?: unknown; name?: unknown };
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    // A DrizzleQueryError's message is the failed statement's text, not the failure. Only its cause describes the
    // failure.
    if (name !== "DrizzleQueryError" && typeof message === "string" && TRANSIENT_MESSAGE.test(message)) return true;
  }
  return false;
}
