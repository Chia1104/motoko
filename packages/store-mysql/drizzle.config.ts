// drizzle-kit's view of the package: `pnpm db:generate` writes the next migration of `src/schema.ts` to `migrations/`,
// which the package ships and `migrate()` applies. Generating needs no database.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
