import { sql } from "drizzle-orm";

import type { StorageScope } from "@chia1104/motoko-core";
import { toNumber } from "@chia1104/motoko-core/store";

import { rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import { scopes } from "./schema.ts";

/**
 * At most `limit` scopes after `after`, in `scope_id` order, that may have unfinished work: those whose last holder
 * released the lease leaving work that can run or a sleep (`wake_*`), and those whose holder never released it (it
 * crashed, or lost the lease). A scope whose lease is held and unexpired is left out: its holder carries on its work,
 * and if it crashed, the scope is listed once its lease expires. One statement, on the partial index
 * `scopes_unfinished`. The schema check is the caller's.
 */
export async function unfinishedScopes(
  db: Database,
  after: number,
  limit: number,
): Promise<(StorageScope & { scopeId: number })[]> {
  const rows = await rowsOf<{ scope_id: unknown; kind: string; name: string }>(
    db,
    sql`SELECT ${scopes.scopeId} AS scope_id, ${scopes.kind} AS kind, ${scopes.name} AS name FROM ${scopes}
      WHERE ${scopes.scopeId} > ${after}::bigint
        AND (${scopes.wakeActive} OR ${scopes.wakeAt} IS NOT NULL OR ${scopes.leaseHolder} IS NOT NULL)
        AND (${scopes.leaseExpiresAt} IS NULL OR ${scopes.leaseExpiresAt} <= clock_timestamp())
      ORDER BY ${scopes.scopeId} LIMIT ${limit}`,
  );
  return rows.map((row) => ({ scopeId: toNumber(row.scope_id), kind: row.kind, name: row.name }));
}
