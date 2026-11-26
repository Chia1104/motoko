import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export const hasUnfinishedWork = (scope: {
  readonly wakeActive: PgColumn;
  readonly wakeAt: PgColumn;
  readonly leaseHolder: PgColumn;
}): SQL => sql`${scope.wakeActive} OR ${scope.wakeAt} IS NOT NULL OR ${scope.leaseHolder} IS NOT NULL`;
