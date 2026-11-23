import type { ConversationId } from "@earendil-works/pi-durable";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { toNumber } from "@chia1104/motoko-core/store";
import type { LeaseRow } from "@chia1104/motoko-core/store";

import { fenced, freshNonce, now, packet, rowsOf, UNBOUNDED } from "./database.ts";
import type { PoolDatabase } from "./database.ts";
import { conversations, documentRevisions, documents, entries, scopes, submissions, tasks } from "./schema.ts";

/** mysql2 parses a JSON column; a pool with `jsonStrings` returns its text. */
const ids = (value: unknown): number[] => {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.map(toNumber) : [];
};

/**
 * Erases conversation `id` of `lease`'s scope, the conversations its tasks made, and everything they own, fenced by
 * the lease as a commit is. One statement reads what the conversation owns and the scope's `next_seq`, while the
 * lease's token is current and unexpired. It skips the conversation, erasing nothing, while any of them has unfinished
 * work or another conversation forks from one of them. Otherwise one round trip deletes them as one transaction: its
 * first statement stamps a fresh nonce on the scope's row only while the lease holds and `next_seq` is still what the
 * read found, so no commit changed what the read saw; then one statement per kind of row (conversations with their
 * entries, documents with their revisions) deletes them where the row holds the nonce. After a commit in between it
 * reads again. `record_ids` keeps the ids, which hold no content, so none is handed out twice. Resolves whether the
 * lease held.
 *
 * Not one round trip: the deletes need what the read found, and MySQL refuses a DELETE whose subqueries read the table
 * it deletes from, so the packet cannot find the conversations it deletes by itself.
 */
export async function eraseConversation(db: PoolDatabase, lease: LeaseRow, id: ConversationId): Promise<boolean> {
  const scopeId = lease.scopeId;
  for (;;) {
    const [found] = await rowsOf<{ next_seq: unknown; owned: unknown; tasks: unknown; blocked: unknown }>(
      db,
      sql`WITH RECURSIVE owned (id) AS (
          SELECT c.id FROM ${conversations} AS c WHERE c.scope_id = ${scopeId} AND c.id = ${id}
          UNION
          SELECT c.id FROM ${conversations} AS c JOIN owned AS o ON c.owner_conversation_id = o.id
            WHERE c.scope_id = ${scopeId}
        )
        SELECT ${UNBOUNDED} s.next_seq, (SELECT JSON_ARRAYAGG(o.id) FROM owned AS o) AS owned,
          (SELECT JSON_ARRAYAGG(t.id) FROM ${tasks} AS t
            WHERE t.scope_id = ${scopeId} AND t.conversation_id IN (SELECT o.id FROM owned AS o)) AS tasks,
          (EXISTS (SELECT 1 FROM ${tasks} AS t WHERE t.scope_id = ${scopeId}
              AND t.conversation_id IN (SELECT o.id FROM owned AS o) AND t.status <> 'terminal')
            -- A fork reads its parent's entries, so the parent must outlive it.
            OR EXISTS (SELECT 1 FROM ${conversations} AS c WHERE c.scope_id = ${scopeId}
              AND c.parent_conversation_id IN (SELECT o.id FROM owned AS o)
              AND c.id NOT IN (SELECT o.id FROM owned AS o))) AS blocked
        FROM ${scopes} AS s
        WHERE s.scope_id = ${scopeId} AND s.lease_token = ${lease.token} AND s.lease_expires_at > ${now}`,
    );
    if (found === undefined) return false;
    const doomed = ids(found.owned);
    if (doomed.length === 0 || Number(found.blocked) === 1) return true;
    const doomedTasks = ids(found.tasks);
    const ownedDocuments = or(
      and(eq(documents.scopeKind, "conversation"), inArray(documents.ownerId, doomed)),
      doomedTasks.length === 0
        ? undefined
        : and(eq(documents.scopeKind, "task"), inArray(documents.ownerId, doomedTasks)),
    );
    const nonce = freshNonce();
    const fence = fenced(scopeId, nonce);
    const results = await packet(db, [
      sql`UPDATE ${scopes} SET commit_nonce = ${nonce}
        WHERE scope_id = ${scopeId} AND next_seq = ${toNumber(found.next_seq)}
          AND lease_token = ${lease.token} AND lease_expires_at > ${now}`,
      sql`DELETE ${documents}, r FROM ${documents}
        LEFT JOIN ${documentRevisions} AS r ON r.scope_id = ${documents.scopeId} AND r.document_id = ${documents.id}
        WHERE ${and(eq(documents.scopeId, scopeId), ownedDocuments)} AND ${fence}`,
      sql`DELETE FROM ${submissions}
        WHERE ${and(eq(submissions.scopeId, scopeId), inArray(submissions.conversationId, doomed))} AND ${fence}`,
      ...(doomedTasks.length === 0
        ? []
        : [
            sql`DELETE FROM ${tasks}
              WHERE ${and(eq(tasks.scopeId, scopeId), inArray(tasks.id, doomedTasks))} AND ${fence}`,
          ]),
      sql`DELETE ${conversations}, e FROM ${conversations}
        LEFT JOIN ${entries} AS e ON e.scope_id = ${conversations.scopeId} AND e.conversation_id = ${conversations.id}
        WHERE ${and(eq(conversations.scopeId, scopeId), inArray(conversations.id, doomed))} AND ${fence}`,
      sql`SELECT ${fence} AS erased, s.lease_token = ${lease.token} AND s.lease_expires_at > ${now} AS held
        FROM (SELECT 1) AS one LEFT JOIN ${scopes} AS s ON s.scope_id = ${scopeId}`,
    ]);
    const [outcome] = results.at(-1) as [{ erased: unknown; held: unknown }];
    if (Number(outcome.erased) === 1) return true;
    if (Number(outcome.held) !== 1) return false;
  }
}
