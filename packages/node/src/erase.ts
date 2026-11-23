import { access } from "node:fs/promises";

import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

import { eraseConversations } from "@chia1104/motoko-core/sqlite";

/**
 * Erases `conversations` from pi-durable's SQLite file `file`, each with what it owns, in one transaction, while no
 * storage has the file open. Deleted rows are overwritten (`secure_delete`) and the write-ahead log truncated, so the
 * erased content is gone from the file, not only unlinked. A conversation that still has unfinished work, or that
 * another conversation forks from, stays; a file that does not exist holds nothing to erase. Rejects, erasing nothing,
 * for a file in a pi-durable schema version other than the one `eraseConversations` is written against.
 */
export async function eraseSqliteConversations(
  file: string,
  conversations: readonly ConversationId[],
  options: { readonly prefix?: string } = {},
): Promise<void> {
  if (conversations.length === 0) return;
  const prefix = options.prefix ?? "";
  // A prefix that cannot name pi's tables is refused before the file is looked at.
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
    // The write-ahead log still holds the pages as they were before.
    await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    await database.close();
  }
}
