import { sql } from "drizzle-orm";
import type { ResultSetHeader } from "mysql2";

import type { StorageScope } from "@chia1104/motoko-core";
import { toNumber } from "@chia1104/motoko-core/store";
import type { LeaseHolder, LeaseRow } from "@chia1104/motoko-core/store";

import { epochMs, now, packet, scopeKey } from "./database.ts";
import type { PoolDatabase } from "./database.ts";
import { scopes } from "./schema.ts";

/** A DELETE that refuses the row keeps it locked until COMMIT, so the read finds it as the DELETE did. */
export async function deleteScope(
  db: PoolDatabase,
  scope: StorageScope,
  lease: LeaseRow | undefined,
): Promise<boolean | LeaseHolder> {
  const key = scopeKey(scope.kind, scope.name);
  const [deleted, [row]] = (await packet(db, [
    sql`DELETE FROM ${scopes} WHERE scope_key = ${key}
      AND (lease_expires_at IS NULL OR lease_expires_at <= ${now}
        OR (scope_id = ${lease?.scopeId ?? null} AND lease_token = ${lease?.token ?? null}))`,
    sql`SELECT lease_holder AS holder, ${epochMs(sql`lease_expires_at`)} AS expires_ms
      FROM ${scopes} WHERE scope_key = ${key}`,
  ])) as [ResultSetHeader, { holder: string | null; expires_ms: unknown }[]];
  if (deleted.affectedRows > 0) return true;
  if (row === undefined) return false;
  return {
    holder: row.holder ?? undefined,
    expiresAt: row.expires_ms === null ? undefined : new Date(toNumber(row.expires_ms)),
  };
}
