import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { StorageScope } from "@chia1104/motoko-core";
import type { LeaseHolder, LeaseRow } from "@chia1104/motoko-core/store";

import { rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import { scopes } from "./schema.ts";

/**
 * Delete everything `scope` owns: its row in `scopes`, which cascades to every record, document, revision and ID of
 * the scope, in one statement, unless a lease other than `lease` is unexpired. Resolves whether there was such a
 * scope, or who holds it. A storage still open on the scope fails its next commit (`ScopeDeletedError`); opening the
 * scope again starts an empty one. The schema check is the caller's.
 */
export async function deleteScope(
  db: Database,
  scope: StorageScope,
  lease: LeaseRow | undefined,
): Promise<boolean | LeaseHolder> {
  const s = alias(scopes, "s");
  const rows = await rowsOf<{ deleted: unknown; holder: string | null; expires_at: Date | string | null }>(
    db,
    sql`WITH target AS (
        SELECT ${scopes.scopeId}, ${scopes.leaseHolder}, ${scopes.leaseExpiresAt} FROM ${scopes}
          WHERE ${scopes.kind} = ${scope.kind}::text AND ${scopes.name} = ${scope.name}::text
      ), deleted AS (
        DELETE FROM ${scopes} AS ${s} USING target
          WHERE ${s.scopeId} = target.scope_id
          -- The scope row's own columns, so a lease acquired concurrently is re-checked on the locked row.
          AND (${s.leaseExpiresAt} IS NULL OR ${s.leaseExpiresAt} <= clock_timestamp()
            OR (${s.scopeId} = ${lease?.scopeId ?? null}::bigint AND ${s.leaseToken} = ${lease?.token ?? null}::bigint))
          RETURNING ${s.scopeId}
      )
      SELECT (SELECT count(*) FROM deleted) AS deleted, lease_holder AS holder, lease_expires_at AS expires_at FROM target`,
  );
  const row = rows[0];
  if (row === undefined) return false;
  if (Number(row.deleted) === 0) {
    return {
      holder: row.holder ?? undefined,
      expiresAt: row.expires_at == null ? undefined : new Date(row.expires_at),
    };
  }
  return true;
}
