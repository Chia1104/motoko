// The lease's statements on MySQL: the holder, the expiry (`UTC_TIMESTAMP(3)`, the database clock) and the fencing
// token live in the scope's row. Why a row lease and not a lock held by a connection (`GET_LOCK`): see
// `@chia1104/motoko-core/store`'s lease.
//
// MySQL has no RETURNING, so a statement that takes or extends a lease cannot say which row it changed. Acquiring
// stamps a nonce of its own on the row as it takes the lease, and reads the row back in the same transaction: the
// lease is the acquirer's exactly when the row holds its nonce.

import type { Wake } from "@earendil-works/pi-durable";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { ResultSetHeader } from "mysql2";

import type { StorageScope } from "@chia1104/motoko-core";
import { toNumber } from "@chia1104/motoko-core/store";
import type { LeaseHolder, LeaseRow, Renewal } from "@chia1104/motoko-core/store";

import { epochMs, expiryIn, freshNonce, now, packet, rowsOf, run, scopeKey } from "./database.ts";
import type { Database, PoolDatabase } from "./database.ts";
import { journalCheck, withJournal } from "./migrations.ts";
import { scopes } from "./schema.ts";

// A type alias, not an interface: a packet's rows are `Record<string, unknown>`, and only an alias has the implicit
// index signature that matches.
// oxlint-disable-next-line typescript/consistent-type-definitions
type AcquiredRow = {
  applied: unknown;
  scope_id: unknown;
  lease_token: unknown;
  holder: string | null;
  expires_ms: unknown;
  taken: unknown;
};

/**
 * Takes the lease of `scope` if it is free or expired, creating the scope's row on first use, in one round trip: a
 * transaction of an upsert and a read of the row it left. The upsert writes only while the journal is this package's
 * migrations, and the read selects the journal too (the schema check). It inserts the row with the lease, or, when the
 * row exists and its lease is free, takes it: the next token, the holder, the expiry, and a fresh nonce. The read
 * finds the nonce exactly when the lease is the acquirer's; otherwise it names the holder. Concurrent acquirers of one
 * scope wait for each other on its row (or its key), so exactly one of them takes it.
 *
 * Every acquisition draws an `AUTO_INCREMENT` value, even when the row exists and the insert turns into the update,
 * so `scope_id` has gaps; nothing reads meaning into them.
 */
export async function acquireLease(
  db: PoolDatabase,
  scope: StorageScope,
  holder: string,
  ttlMs: number,
): Promise<LeaseRow | LeaseHolder> {
  const nonce = freshNonce();
  const free = sql`(${scopes.leaseExpiresAt} IS NULL OR ${scopes.leaseExpiresAt} <= ${now})`;
  // Assigned in order, each seeing the ones before it: the expiry, which `free` reads, goes last.
  const takeIfFree = (column: string, taken: SQL) =>
    sql`${sql.identifier(column)} = IF(${free}, ${taken}, ${scopes}.${sql.identifier(column)})`;
  const [, [row]] = (await withJournal(db, () =>
    packet(db, [
      sql`INSERT INTO ${scopes} (kind, name, lease_token, lease_holder, lease_expires_at, commit_nonce)
        SELECT * FROM (SELECT ${scope.kind} AS kind, ${scope.name} AS name, 1 AS lease_token,
            ${holder} AS lease_holder, ${expiryIn(ttlMs)} AS lease_expires_at, ${nonce} AS commit_nonce) AS a
          WHERE ${journalCheck.current}
        ON DUPLICATE KEY UPDATE ${sql.join(
          [
            takeIfFree("commit_nonce", sql`a.commit_nonce`),
            takeIfFree("lease_token", sql`${scopes.leaseToken} + 1`),
            takeIfFree("lease_holder", sql`a.lease_holder`),
            takeIfFree("lease_expires_at", sql`a.lease_expires_at`),
          ],
          sql`, `,
        )}`,
      sql`SELECT ${journalCheck.applied} AS applied, s.scope_id, s.lease_token, s.lease_holder AS holder,
          ${epochMs(sql`s.lease_expires_at`)} AS expires_ms, s.commit_nonce = ${nonce} AS taken
        FROM (SELECT 1) AS one LEFT JOIN ${scopes} AS s ON s.scope_key = ${scopeKey(scope.kind, scope.name)}`,
    ]),
  )) as [ResultSetHeader, [AcquiredRow]];
  journalCheck.assertCurrent(row.applied);
  if (Number(row.taken) === 1) return { scopeId: toNumber(row.scope_id), token: toNumber(row.lease_token) };
  return {
    holder: row.holder ?? undefined,
    expiresAt: row.expires_ms === null ? undefined : new Date(toNumber(row.expires_ms)),
  };
}

/**
 * Extends the expiry of each lease that is still its holder's and unexpired, in one statement. When it extended them
 * all, that is every lease's answer; otherwise one more statement reads each scope's token and expiry, so a lease that
 * was not extended learns why (taken, expired, or its scope deleted).
 *
 * The extending statement's count is of the rows it matched or of the rows it changed, as the client's
 * `CLIENT_FOUND_ROWS` flag says (mysql2 sets it); a row renewed twice within a millisecond counts only as matched, so
 * a count short of all of them is only ever answered by the read.
 */
export async function renewLeases(db: Database, leases: readonly LeaseRow[], ttlMs: number): Promise<Renewal[]> {
  const ids = leases.map((lease) => lease.scopeId);
  const pairs = sql.join(
    leases.map((lease) => sql`(${lease.scopeId}, ${lease.token})`),
    sql`, `,
  );
  const extended = await run(
    db,
    sql`UPDATE ${scopes} SET lease_expires_at = ${expiryIn(ttlMs)}
      WHERE ${inArray(scopes.scopeId, ids)} AND (scope_id, lease_token) IN (${pairs})
        AND lease_expires_at > ${now}`,
  );
  if (extended.affectedRows === leases.length) {
    return leases.map(({ scopeId, token }) => ({ scopeId, token, leaseToken: token, held: true }));
  }
  const rows = await rowsOf<{ scope_id: unknown; lease_token: unknown; live: unknown }>(
    db,
    sql`SELECT scope_id, lease_token, lease_expires_at > ${now} AS live FROM ${scopes}
      WHERE ${inArray(scopes.scopeId, ids)}`,
  );
  const found = new Map(rows.map((row) => [toNumber(row.scope_id), row]));
  return leases.map(({ scopeId, token }) => {
    const row = found.get(scopeId);
    if (row === undefined) return { scopeId, token, leaseToken: undefined, held: false };
    const leaseToken = toNumber(row.lease_token);
    return { scopeId, token, leaseToken, held: leaseToken === token && Number(row.live) === 1 };
  });
}

/** Frees the scope if `lease` is still its holder's, recording `wake` (work that can run without one). */
export async function releaseLease(db: Database, lease: LeaseRow, wake: Wake | undefined): Promise<void> {
  await db
    .update(scopes)
    .set({
      leaseHolder: null,
      leaseExpiresAt: null,
      wakeActive: wake?.active ?? true,
      wakeAt: wake?.at === undefined ? null : Math.ceil(wake.at),
    })
    .where(and(eq(scopes.scopeId, lease.scopeId), eq(scopes.leaseToken, lease.token)));
}
