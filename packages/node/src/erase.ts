import { access } from "node:fs/promises";

import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

import { eraseConversations } from "@chia1104/motoko-core/sqlite";

/**
 * Erases `conversations` from pi-durable's SQLite file `file`, each with what it owns, in one transaction, while no
 * storage has the file open. It overwrites the deleted rows with `secure_delete` and truncates the write-ahead log, so
 * the erased content is gone from the file, not only unlinked. A conversation that still has unfinished work, or that
 * another conversation forks from, stays. A file that does not exist holds nothing to erase. For a file in a pi-durable
 * schema version other than the one `eraseConversations` is written against, it rejects and erases nothing.
 */
export async function eraseSqliteConversations(
  file: string,
  conversations: readonly ConversationId[],
  options: { readonly prefix?: string } = {},
): Promise<void> {
  if (conversations.length === 0) return;
  const prefix = options.prefix ?? "";
  if (prefix !== "") validateSqliteSchemaPrefix(prefix);
  try {
    await access(file);
  } catch {
    return;
  }
  const database = await openNodeSqliteDatabase(file);
  try {
    await database.exec("PRAGMA secure_delete = ON");
    await eraseConversations(database, conversations, { prefix, label: file });
    await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    await database.close();
  }
}
