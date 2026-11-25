import type { ConversationId } from "@earendil-works/pi-durable";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { toNumber } from "@chia1104/motoko-core/store";
import type { LeaseRow } from "@chia1104/motoko-core/store";

import { fenced, freshNonce, now, packet, rowsOf, UNBOUNDED } from "./database.ts";
import type { PoolDatabase } from "./database.ts";
import { conversations, documentRevisions, documents, entries, scopes, submissions, tasks } from "./schema.ts";

/** mysql2 parses a JSON column. A pool with `jsonStrings` returns its text instead. */
const ids = (value: unknown): number[] => {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.map(toNumber) : [];
};

/**
 * Erasing takes more than one round trip. MySQL refuses a DELETE whose subqueries read the table it deletes from, so
 * the packet cannot find the conversations it deletes by itself. The deletes need what an earlier read found.
 */
export type EraseResult = "lease-held" | "lease-lost";

export async function eraseConversation(db: PoolDatabase, lease: LeaseRow, id: ConversationId): Promise<EraseResult> {
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
            OR EXISTS (SELECT 1 FROM ${conversations} AS c WHERE c.scope_id = ${scopeId}
              AND c.parent_conversation_id IN (SELECT o.id FROM owned AS o)
              AND c.id NOT IN (SELECT o.id FROM owned AS o))) AS blocked
        FROM ${scopes} AS s
        WHERE s.scope_id = ${scopeId} AND s.lease_token = ${lease.token} AND s.lease_expires_at > ${now}`,
    );
    if (found === undefined) return "lease-lost";
    const doomed = ids(found.owned);
    if (doomed.length === 0 || Number(found.blocked) === 1) return "lease-held";
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
    if (Number(outcome.erased) === 1) return "lease-held";
    if (Number(outcome.held) !== 1) return "lease-lost";
  }
}
