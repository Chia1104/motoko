import { sql } from "drizzle-orm";

import type { StorageScope } from "@chia1104/motoko-core";
import { toNumber } from "@chia1104/motoko-core/store";

import { rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import { hasUnfinishedWork } from "./expressions.ts";
import { scopes } from "./schema.ts";

export async function unfinishedScopes(
  db: Database,
  after: number,
  limit: number,
): Promise<(StorageScope & { scopeId: number })[]> {
  const rows = await rowsOf<{ scope_id: unknown; kind: string; name: string }>(
    db,
    sql`SELECT ${scopes.scopeId} AS scope_id, ${scopes.kind} AS kind, ${scopes.name} AS name FROM ${scopes}
      WHERE ${scopes.scopeId} > ${after}::bigint
        AND (${hasUnfinishedWork(scopes)})
        AND (${scopes.leaseExpiresAt} IS NULL OR ${scopes.leaseExpiresAt} <= clock_timestamp())
      ORDER BY ${scopes.scopeId} LIMIT ${limit}`,
  );
  return rows.map((row) => ({ scopeId: toNumber(row.scope_id), kind: row.kind, name: row.name }));
}
