import type { Wake } from "@earendil-works/pi-durable";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { StorageScope } from "@chia1104/motoko-core";
import { toNumber } from "@chia1104/motoko-core/store";
import type { LeaseHolder, LeaseRow, Renewal } from "@chia1104/motoko-core/store";

import { rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import { journalCheck, missingJournalAsVersionError } from "./migrations.ts";
import { scopes } from "./schema.ts";

const expiryIn = (ms: number) => sql`clock_timestamp() + ${ms}::double precision * interval '1 millisecond'`;

const name = (column: { name: string }): SQL => sql`${sql.identifier(column.name)}`;

/**
 * The unique key serializes concurrent first acquisitions of a new scope. The loser's upsert waits for the winner's row
 * and finds its lease unexpired. Each attempt draws a `scope_id` from the identity sequence even when the row exists,
 * so the sequence has gaps. Nothing depends on the ids being contiguous.
 */
export async function acquireLease(
  db: Database,
  scope: StorageScope,
  holder: string,
  ttlMs: number,
): Promise<LeaseRow | LeaseHolder> {
  const kind = sql`${scope.kind}::text`;
  const label = sql`${scope.name}::text`;
  const rows = await missingJournalAsVersionError(db, () =>
    rowsOf<{ applied: string[]; scope_id: unknown; lease_token: unknown }>(
      db,
      sql`WITH journal AS (SELECT ${journalCheck.applied} AS applied),
        acquired AS (
          INSERT INTO ${scopes} AS s (${name(scopes.kind)}, ${name(scopes.name)}, ${name(scopes.leaseToken)},
              ${name(scopes.leaseHolder)}, ${name(scopes.leaseExpiresAt)})
            SELECT ${kind}, ${label}, 1, ${holder}::text, ${expiryIn(ttlMs)} FROM journal
              WHERE ${journalCheck.current(sql`journal.applied`)}
            ON CONFLICT (${name(scopes.kind)}, ${name(scopes.name)}) DO UPDATE
              SET ${name(scopes.leaseToken)} = s.${name(scopes.leaseToken)} + 1,
                ${name(scopes.leaseHolder)} = excluded.${name(scopes.leaseHolder)},
                ${name(scopes.leaseExpiresAt)} = excluded.${name(scopes.leaseExpiresAt)}
              WHERE s.${name(scopes.leaseExpiresAt)} IS NULL OR s.${name(scopes.leaseExpiresAt)} <= clock_timestamp()
            RETURNING s.${name(scopes.scopeId)}, s.${name(scopes.leaseToken)}
        )
        SELECT journal.applied, acquired.scope_id, acquired.lease_token FROM journal LEFT JOIN acquired ON true`,
    ),
  );
  const row = rows[0];
  journalCheck.assertCurrent(row?.applied);
  if (row === undefined || row.scope_id === null) {
    const held = await db
      .select({ holder: scopes.leaseHolder, expiresAt: scopes.leaseExpiresAt })
      .from(scopes)
      .where(and(eq(scopes.kind, scope.kind), eq(scopes.name, scope.name)));
    return { holder: held[0]?.holder ?? undefined, expiresAt: held[0]?.expiresAt ?? undefined };
  }
  return { scopeId: toNumber(row.scope_id), token: toNumber(row.lease_token) };
}

export async function renewLeases(db: Database, leases: readonly LeaseRow[], ttlMs: number): Promise<Renewal[]> {
  const ids = sql`${sql.param(leases.map((lease) => lease.scopeId))}::bigint[]`;
  const tokens = sql`${sql.param(leases.map((lease) => lease.token))}::bigint[]`;
  const rows = await rowsOf<{ scope_id: unknown; token: unknown; lease_token: unknown; held: boolean }>(
    db,
    sql`with "renewed" as (update ${scopes} set ${name(scopes.leaseExpiresAt)} = ${expiryIn(ttlMs)}
        from unnest(${ids}, ${tokens}) as l(scope_id, token)
        where ${scopes.scopeId} = l.scope_id and ${scopes.leaseToken} = l.token
          and ${scopes.leaseExpiresAt} > clock_timestamp()
        returning ${scopes.scopeId}, ${scopes.leaseToken})
      select l.scope_id, l.token, s.${name(scopes.leaseToken)} as lease_token,
        exists (select 1 from renewed r where r.scope_id = l.scope_id and r.lease_token = l.token) as held
      from unnest(${ids}, ${tokens}) as l(scope_id, token)
        left join ${scopes} as s on s.${name(scopes.scopeId)} = l.scope_id`,
  );
  return rows.map((row) => ({
    scopeId: toNumber(row.scope_id),
    token: toNumber(row.token),
    leaseToken: row.lease_token === null ? undefined : toNumber(row.lease_token),
    held: row.held === true,
  }));
}

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
