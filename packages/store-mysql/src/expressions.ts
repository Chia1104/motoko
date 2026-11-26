import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

export const scopeKeyOf = (kind: SQLWrapper | string, name: SQLWrapper | string): SQL =>
  sql`unhex(sha2(concat(${kind}, x'00', ${name}), 256))`;
