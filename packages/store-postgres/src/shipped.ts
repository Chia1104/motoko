/**
 * The version check at every lease and open compares the database's journal with this list, so it reads no file. An app
 * that bundles this package, or whose deploy traces only imported modules, still ships the check.
 */
export const SHIPPED_MIGRATIONS: readonly string[] = ["20261123143004_init"];
