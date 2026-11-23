#!/usr/bin/env node
// `motoko-store-postgres [migrate|check]`: applies the migrations this package ships to the database at
// AGENT_RUNTIME_DATABASE_URL (or DATABASE_URL), or checks that it is at this package's version. For deploy scripts:
// exit code 0 on success, 1 on failure, 2 on a usage error.

import pg from "pg";

import { checkSchema, migrate } from "./index.ts";

const USAGE = "Usage: motoko-store-postgres [migrate|check]   (connection: AGENT_RUNTIME_DATABASE_URL or DATABASE_URL)";

/**
 * The connection string without its password, for the log. WHATWG parsing ends the user info at the last `@`, so a
 * password with an unescaped `@` is hidden whole; a string that is not a URL (a key=value one) is not printed at all.
 */
const redact = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    // A driver also reads a password from the query (`?password=`, `?sslpassword=`).
    for (const key of [...parsed.searchParams.keys()]) if (/pass/i.test(key)) parsed.searchParams.set(key, "***");
    return parsed.href;
  } catch {
    return "the configured database";
  }
};

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const command = argv[0] ?? "migrate";
  if ((command !== "migrate" && command !== "check") || argv.length > 1) {
    console.error(USAGE);
    return 2;
  }
  const url = env.AGENT_RUNTIME_DATABASE_URL || env.DATABASE_URL;
  if (url === undefined || url === "") {
    console.error(`No database: set AGENT_RUNTIME_DATABASE_URL or DATABASE_URL.\n${USAGE}`);
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on("error", () => undefined);
  try {
    if (command === "check") {
      await checkSchema(pool);
      console.log(`Motoko tables at ${redact(url)} are up to date`);
    } else {
      const { applied } = await migrate(pool);
      console.log(
        applied.length === 0
          ? `Motoko tables at ${redact(url)} are up to date`
          : `Applied ${applied.length} migration(s) to ${redact(url)}: ${applied.join(", ")}`,
      );
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main(process.argv.slice(2), process.env);
