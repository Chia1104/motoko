/**
 * The names of the migrations in `migrations/`, in order. The version check at every lease and open compares the
 * database's journal with this list, so it reads no file: an app that bundles this package, or whose deploy traces
 * only imported modules, still ships the check. Only `migrate()` and the CLI read the SQL files.
 *
 * Add the new folder's name here when `pnpm db:generate` writes a migration; a test fails until the two agree.
 */
export const SHIPPED_MIGRATIONS: readonly string[] = ["20261123143004_init"];
