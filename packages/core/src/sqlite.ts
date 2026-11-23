/**
 * `@chia1104/motoko-core/sqlite`: erasing deleted sessions from pi-durable's SQLite schema through chord's portable
 * `SqliteDatabase`, so every store on SQLite (a file in Node, a Durable Object's database) runs the same statements.
 * What only one environment can do (opening a file, a PRAGMA) stays with its store.
 */

import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { ConversationId } from "@earendil-works/pi-durable";

/**
 * The pi-durable SQLite schema version the statements below are written against. pi-durable has no way to delete a
 * conversation, so these read and delete its tables directly; a database in any other version is refused unchanged.
 */
const ERASABLE_SCHEMA_VERSION = 2;

/** pi-durable's SQLite tables under `prefix`. */
function tablesOf(prefix: string) {
  if (prefix !== "") validateSqliteSchemaPrefix(prefix);
  const table = (name: string) => `${prefix}${name}`;
  return {
    durableSchema: table("durable_schema"),
    conversations: table("conversations"),
    entries: table("entries"),
    tasks: table("tasks"),
    submissions: table("submissions"),
    documents: table("documents"),
    documentRevisions: table("document_revisions"),
  };
}

type Tables = ReturnType<typeof tablesOf>;

const ids = (rows: readonly { id: number }[]) => JSON.stringify(rows.map((row) => row.id));

/** Matches an id in a JSON array bound as one parameter. */
const IN_IDS = "IN (SELECT value FROM json_each(?))";

/**
 * Erases conversation `id`, the conversations its tasks made, and everything they own. Skips it, erasing nothing,
 * while any of them has unfinished work or another conversation forks from one of them. `record_ids` keeps the ids,
 * which hold no content, so none is handed out twice.
 */
async function eraseOne(tx: SqliteExecutor, t: Tables, id: ConversationId): Promise<void> {
  const conversations = ids(
    await tx.all<{ id: number }>(
      `WITH RECURSIVE owned(id) AS (
        SELECT id FROM ${t.conversations} WHERE id = ?
        UNION
        SELECT c.id FROM ${t.conversations} c JOIN owned ON c.owner_conversation_id = owned.id
      )
      SELECT id FROM owned`,
      id,
    ),
  );
  if (conversations === "[]") return;
  const busy = await tx.get<{ count: number }>(
    `SELECT count(*) AS count FROM ${t.tasks} WHERE conversation_id ${IN_IDS} AND status != 'terminal'`,
    conversations,
  );
  // A fork reads its parent's entries, so the parent must outlive it.
  const forks = await tx.get<{ count: number }>(
    `SELECT count(*) AS count FROM ${t.conversations}
      WHERE json_extract(record, '$.parent.conversationId') ${IN_IDS} AND id NOT ${IN_IDS}`,
    conversations,
    conversations,
  );
  if ((busy?.count ?? 0) > 0 || (forks?.count ?? 0) > 0) return;
  const tasks = ids(
    await tx.all<{ id: number }>(`SELECT id FROM ${t.tasks} WHERE conversation_id ${IN_IDS}`, conversations),
  );
  const documents = ids(
    await tx.all<{ id: number }>(
      `SELECT id FROM ${t.documents}
        WHERE (scope_kind = 'conversation' AND owner_id ${IN_IDS}) OR (scope_kind = 'task' AND owner_id ${IN_IDS})`,
      conversations,
      tasks,
    ),
  );
  await tx.run(`DELETE FROM ${t.documentRevisions} WHERE document_id ${IN_IDS}`, documents);
  await tx.run(`DELETE FROM ${t.documents} WHERE id ${IN_IDS}`, documents);
  await tx.run(`DELETE FROM ${t.submissions} WHERE conversation_id ${IN_IDS}`, conversations);
  await tx.run(`DELETE FROM ${t.tasks} WHERE id ${IN_IDS}`, tasks);
  await tx.run(`DELETE FROM ${t.entries} WHERE conversation_id ${IN_IDS}`, conversations);
  await tx.run(`DELETE FROM ${t.conversations} WHERE id ${IN_IDS}`, conversations);
}

export interface EraseConversationsOptions {
  /** The table prefix pi-durable's storage was opened with. Default: none. */
  readonly prefix?: string;
  /** How the schema error names the database, such as its file. Default: `the database`. */
  readonly label?: string;
}

/**
 * Erases `conversations` from pi-durable's SQLite tables in `database`, each with what it owns, in one transaction,
 * while no storage has them open. A conversation that still has unfinished work, or that another conversation forks
 * from, stays, and so does one the database does not hold. Rejects, erasing nothing, for a database in a pi-durable
 * schema version other than the one this is written against. The rows are deleted; whether their bytes are overwritten
 * as well is the store's to arrange (`PRAGMA secure_delete`, where the database allows it).
 */
export async function eraseConversations(
  database: Pick<SqliteDatabase, "transaction">,
  conversations: readonly ConversationId[],
  options: EraseConversationsOptions = {},
): Promise<void> {
  if (conversations.length === 0) return;
  const t = tablesOf(options.prefix ?? "");
  await database.transaction(async (tx) => {
    const schema = await tx.get<{ version: number }>(`SELECT version FROM ${t.durableSchema} WHERE singleton = 1`);
    if (schema?.version !== ERASABLE_SCHEMA_VERSION) {
      throw new Error(
        `Cannot erase conversations from ${options.label ?? "the database"}: it is in pi-durable SQLite schema ` +
          `${String(schema?.version)}, not ${ERASABLE_SCHEMA_VERSION}`,
      );
    }
    for (const id of conversations) await eraseOne(tx, t, id);
  });
}
