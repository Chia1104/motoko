// What the package runs on: a Drizzle Postgres database, whichever driver built it (node-postgres at the root
// export, PGlite at `/pglite`). Query-builder statements return the same values on both; for `sql` statements the
// rows come back as the driver parsed them, so integers go through `toNumber` and errors through `causes`.

import type { SQL } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** A Drizzle Postgres database over any async driver. Relations are unused: `any` is what Drizzle's migrator takes. */
export type Database = PgAsyncDatabase<PgQueryResultHKT, any>; // oxlint-disable-line typescript/no-explicit-any

/**
 * Runs one `sql` statement (one round trip) and returns its rows as objects, as the driver parsed them: int8 is a
 * `string` on node-postgres and a `number` on PGlite, json and arrays are parsed by both.
 */
export function rowsOf<Row extends Record<string, unknown>>(db: Database, query: SQL): Promise<Row[]> {
  return db.execute<Row>(query, "objects");
}

/** `error` and its `cause` chain: Drizzle wraps a driver's error in a `DrizzleQueryError` whose `cause` it is. */
export function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && current !== null && chain.length < 8;) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/** The first Postgres (or socket) error code in `error`'s cause chain. */
export function errorCode(error: unknown): string | undefined {
  for (const link of causes(error)) {
    const code = typeof link === "object" && link !== null ? (link as { code?: unknown }).code : undefined;
    if (typeof code === "string") return code;
  }
  return undefined;
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
]);

const TRANSIENT_MESSAGE = /Connection terminated|connection error|Client was closed|terminating connection/i;

/** A failure of the connection, not of the statement: the statement may be retried if it is idempotent. */
export function isTransientError(error: unknown): boolean {
  for (const link of causes(error)) {
    if (typeof link !== "object" || link === null) continue;
    const { code, message, name } = link as { code?: unknown; message?: unknown; name?: unknown };
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    // A DrizzleQueryError's message is the failed statement's text, not the failure: only its cause tells.
    if (name !== "DrizzleQueryError" && typeof message === "string" && TRANSIENT_MESSAGE.test(message)) return true;
  }
  return false;
}
