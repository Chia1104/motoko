import { sql } from "drizzle-orm";

import type { StorageScope } from "@chia1104/motoko-core";
import { toNumber } from "@chia1104/motoko-core/store";

import { now, rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import { scopes } from "./schema.ts";

export async function unfinishedScopes(
  db: Database,
  after: number,
  limit: number,
): Promise<(StorageScope & { scopeId: number })[]> {
  const rows = await rowsOf<{ scope_id: unknown; kind: string; name: string }>(
    db,
    sql`SELECT scope_id, kind, name FROM ${scopes}
      WHERE unfinished = TRUE AND scope_id > ${after}
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${now})
      ORDER BY scope_id LIMIT ${limit}`,
  );
  return rows.map((row) => ({ scopeId: toNumber(row.scope_id), kind: row.kind, name: row.name }));
}
