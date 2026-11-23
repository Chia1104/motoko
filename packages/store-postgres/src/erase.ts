import type { ConversationId } from "@earendil-works/pi-durable";
import { sql } from "drizzle-orm";

import type { LeaseRow } from "@chia1104/motoko-core/store";

import { rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import { conversations, documentRevisions, documents, entries, scopes, submissions, tasks } from "./schema.ts";

/**
 * Erases conversation `id` of `lease`'s scope, the conversations its tasks made, and everything they own, in one
 * statement fenced by the lease as a commit is: it locks the scope's row and requires the lease's token to be current
 * and unexpired. Skips the conversation, erasing nothing, while any of them has unfinished work or another
 * conversation forks from one of them. `record_ids` keeps the ids, which hold no content, so none is handed out twice.
 * Resolves whether the lease held.
 */
export async function eraseConversation(db: Database, lease: LeaseRow, id: ConversationId): Promise<boolean> {
  const scope = sql`${lease.scopeId}::bigint`;
  const rows = await rowsOf<{ fenced: unknown }>(
    db,
    sql`WITH RECURSIVE
      fence AS (UPDATE ${scopes} SET ${sql.identifier(scopes.leaseToken.name)} = ${scopes.leaseToken}
        WHERE ${scopes.scopeId} = ${scope} AND ${scopes.leaseToken} = ${lease.token}::bigint
          AND ${scopes.leaseExpiresAt} > clock_timestamp()
        RETURNING ${scopes.scopeId}),
      owned(id) AS (
        SELECT c.id FROM ${conversations} c, fence WHERE c.scope_id = fence.scope_id AND c.id = ${id}::bigint
        UNION
        SELECT c.id FROM ${conversations} c JOIN owned o ON c.owner_conversation_id = o.id WHERE c.scope_id = ${scope}
      ),
      blocked AS (
        SELECT 1 FROM ${tasks} t WHERE t.scope_id = ${scope}
          AND t.conversation_id IN (SELECT id FROM owned) AND t.status <> 'terminal'
        UNION ALL
        -- A fork reads its parent's entries, so the parent must outlive it.
        SELECT 1 FROM ${conversations} c WHERE c.scope_id = ${scope}
          AND c.parent_conversation_id IN (SELECT id FROM owned) AND c.id NOT IN (SELECT id FROM owned)
      ),
      doomed AS (SELECT id FROM owned WHERE NOT EXISTS (SELECT 1 FROM blocked)),
      doomed_tasks AS (
        SELECT t.id FROM ${tasks} t WHERE t.scope_id = ${scope} AND t.conversation_id IN (SELECT id FROM doomed)
      ),
      doomed_documents AS (
        SELECT d.id FROM ${documents} d WHERE d.scope_id = ${scope} AND (
          (d.scope_kind = 'conversation' AND d.owner_id IN (SELECT id FROM doomed))
          OR (d.scope_kind = 'task' AND d.owner_id IN (SELECT id FROM doomed_tasks)))
      ),
      erased_revisions AS (DELETE FROM ${documentRevisions}
        WHERE scope_id = ${scope} AND document_id IN (SELECT id FROM doomed_documents)),
      erased_documents AS (DELETE FROM ${documents}
        WHERE scope_id = ${scope} AND id IN (SELECT id FROM doomed_documents)),
      erased_submissions AS (DELETE FROM ${submissions}
        WHERE scope_id = ${scope} AND conversation_id IN (SELECT id FROM doomed)),
      erased_tasks AS (DELETE FROM ${tasks} WHERE scope_id = ${scope} AND id IN (SELECT id FROM doomed_tasks)),
      erased_entries AS (DELETE FROM ${entries}
        WHERE scope_id = ${scope} AND conversation_id IN (SELECT id FROM doomed)),
      erased_conversations AS (DELETE FROM ${conversations}
        WHERE scope_id = ${scope} AND id IN (SELECT id FROM doomed))
      SELECT (SELECT count(*) FROM fence) AS fenced`,
  );
  return Number(rows[0]?.fenced ?? 0) > 0;
}
