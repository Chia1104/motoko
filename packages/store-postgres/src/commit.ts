import type { DocumentCopySource, DocumentRecord, StoredDocument } from "@earendil-works/pi-durable";
import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import { addressParts, encodeIndexedString, encodeJson, parseJson, toNumber } from "@chia1104/motoko-core/store";
import type {
  AddressParts,
  CheckQuery,
  CheckState,
  CommitGuard,
  CommitPlan,
  CommitPort,
  RecordTable,
  ScopeKind,
  WriteOutcome,
} from "@chia1104/motoko-core/store";

import { isTransientError, rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import {
  conversations,
  documentRevisions,
  documents,
  entries,
  recordIds,
  scopes,
  submissions,
  tasks,
} from "./schema.ts";

export function commitPort(
  db: Database,
  scopeId: number,
  readSource: (source: DocumentCopySource) => Promise<() => StoredDocument | undefined>,
): CommitPort {
  return {
    read: (query) => readCheckState(db, scopeId, query),
    write: (guard, plan) => writePlan(db, scopeId, guard, plan),
    readSource,
    isTransientError,
  };
}

async function readCheckState(db: Database, scopeId: number, query: CheckQuery): Promise<CheckState | undefined> {
  const address = query.addresses;
  const s = alias(scopes, "s");
  const r = alias(recordIds, "r");
  const d = alias(documents, "d");
  const v = alias(documentRevisions, "v");
  const id = sql`${scopeId}::bigint`;
  const rows = await rowsOf<{
    next_id: unknown;
    next_seq: unknown;
    lease_token: unknown;
    ids: [number, RecordTable][];
    documents: string[];
    versions: [number, number | null][];
    current: [number, string, ScopeKind, number, number, string][];
  }>(
    db,
    sql`SELECT ${s.nextId}, ${s.nextSeq}, ${s.leaseToken},
      (SELECT coalesce(json_agg(json_build_array(${r.id}, ${r.recordType})), '[]'::json)
        FROM ${recordIds} AS ${r} WHERE ${r.scopeId} = ${id} AND ${r.id} = ANY(${sql.param([...query.ids])}::bigint[])) AS ids,
      ARRAY(SELECT ${d.record} FROM ${documents} AS ${d}
        WHERE ${d.scopeId} = ${id} AND ${d.id} = ANY(${sql.param([...query.documents])}::bigint[])) AS documents,
      (SELECT coalesce(json_agg(json_build_array(q.id, (
        SELECT ${v.version} FROM ${documentRevisions} AS ${v}
          WHERE ${v.scopeId} = ${id} AND ${v.documentId} = q.id ORDER BY ${v.seq} DESC LIMIT 1
      ))), '[]'::json) FROM unnest(${sql.param([...query.deltas])}::bigint[]) AS q(id)) AS versions,
      (SELECT coalesce(json_agg(json_build_array(${d.id}, ${d.kind}, ${d.scopeKind}, ${d.ownerId}, ${d.family}, ${d.keyValue})), '[]'::json)
        FROM unnest(
          ${sql.param(address.map((part) => part.kind))}::text[],
          ${sql.param(address.map((part) => part.scopeKind))}::text[],
          ${sql.param(address.map((part) => part.ownerId))}::bigint[],
          ${sql.param(address.map((part) => part.family))}::smallint[],
          ${sql.param(address.map((part) => part.keyValue))}::text[]
        ) AS a(kind, scope_kind, owner_id, family, key_value)
        JOIN ${documents} AS ${d} ON ${d.scopeId} = ${id} AND ${d.kind} = a.kind AND ${d.scopeKind} = a.scope_kind
          AND ${d.ownerId} = a.owner_id AND ${d.family} = a.family AND ${d.keyValue} = a.key_value
        WHERE ${d.retiredAt} IS NULL) AS current
    FROM ${scopes} AS ${s} WHERE ${s.scopeId} = ${id}`,
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const versions: (readonly [number, number])[] = [];
  for (const [document, version] of row.versions) {
    if (version !== null) versions.push([toNumber(document), toNumber(version)]);
  }
  return {
    nextId: toNumber(row.next_id),
    nextSeq: toNumber(row.next_seq),
    leaseToken: toNumber(row.lease_token),
    claims: row.ids.map(([claimed, table]) => [toNumber(claimed), table] as const),
    documents: row.documents.map((text) => parseJson<DocumentRecord>(text)),
    versions,
    current: row.current.map(([document, kind, scopeKind, ownerId, family, keyValue]) => {
      const parts: AddressParts = {
        kind,
        scopeKind,
        ownerId: toNumber(ownerId),
        family: toNumber(family) === 0 ? 0 : 1,
        keyValue,
      };
      return [toNumber(document), parts] as const;
    }),
  };
}

const name = (column: PgColumn): SQL => sql`${sql.identifier(column.name)}`;

type PgTableWithScope = PgTable & { scopeId: PgColumn };

function planStatement(scopeId: number, guard: CommitGuard, plan: CommitPlan): SQL {
  const ctes: SQL[] = [];
  const leaseCondition = sql` AND ${scopes.leaseToken} = ${guard.leaseToken}::bigint AND ${scopes.leaseExpiresAt} > clock_timestamp()`;
  ctes.push(
    sql`guard AS (UPDATE ${scopes} SET ${name(scopes.nextSeq)} = ${guard.nextSeq}::bigint,
      ${name(scopes.nextId)} = GREATEST(${scopes.nextId}, ${guard.nextId}::bigint)
      WHERE ${scopes.scopeId} = ${scopeId}::bigint AND ${scopes.nextSeq} = ${guard.expectedSeq}::bigint${leaseCondition}
      RETURNING ${scopes.scopeId})`,
  );
  const insert = (
    cte: string,
    table: PgTableWithScope,
    columns: readonly (readonly [column: PgColumn, type: string, values: readonly unknown[]])[],
    conflict: SQL = sql``,
  ) => {
    if (columns[0]?.[2].length === 0) return;
    const names = sql.join(
      columns.map(([column]) => name(column)),
      sql`, `,
    );
    const arrays = sql.join(
      columns.map(([, type, values]) => sql`${sql.param(values)}::${sql.raw(type)}[]`),
      sql`, `,
    );
    const selected = sql.join(
      columns.map(([column]) => sql`u.${name(column)}`),
      sql`, `,
    );
    ctes.push(
      sql`${sql.identifier(cte)} AS (INSERT INTO ${table} (${name(table.scopeId)}, ${names})
        SELECT g.scope_id, ${selected} FROM guard g, unnest(${arrays}) AS u(${names})${conflict})`,
    );
  };
  const upsert = (table: PgTableWithScope & { id: PgColumn }, columns: readonly PgColumn[]): SQL =>
    sql` ON CONFLICT (${name(table.scopeId)}, ${name(table.id)}) DO UPDATE SET ${sql.join(
      columns.map((column) => sql`${name(column)} = excluded.${name(column)}`),
      sql`, `,
    )}`;

  const claims = plan.claims;
  insert(
    "w_record_ids",
    recordIds,
    [
      [recordIds.id, "bigint", claims.map(([id]) => id)],
      [recordIds.recordType, "text", claims.map(([, table]) => table)],
    ],
    sql` ON CONFLICT (${name(recordIds.scopeId)}, ${name(recordIds.id)}) DO NOTHING`,
  );
  const conversationRows = plan.conversations;
  insert("w_conversations", conversations, [
    [conversations.id, "bigint", conversationRows.map((record) => record.id)],
    [
      conversations.ownerConversationId,
      "bigint",
      conversationRows.map((record) => record.owner?.conversationId ?? null),
    ],
    [conversations.ownerTaskId, "bigint", conversationRows.map((record) => record.owner?.taskId ?? null)],
    [
      conversations.parentConversationId,
      "bigint",
      conversationRows.map((record) => record.parent?.conversationId ?? null),
    ],
    [conversations.parentAt, "bigint", conversationRows.map((record) => record.parent?.at ?? null)],
    [conversations.record, "text", conversationRows.map((record) => encodeJson(record))],
  ]);
  const entryRows = plan.entries;
  insert("w_entries", entries, [
    [entries.id, "bigint", entryRows.map(({ record }) => record.id)],
    [entries.conversationId, "bigint", entryRows.map(({ record }) => record.conversationId)],
    [entries.head, "bigint", entryRows.map(({ record }) => record.head ?? null)],
    [entries.commitSeq, "bigint", entryRows.map(({ seq }) => seq)],
    [entries.record, "text", entryRows.map(({ record }) => encodeJson(record))],
  ]);
  const taskRows = plan.tasks;
  insert(
    "w_tasks",
    tasks,
    [
      [tasks.id, "bigint", taskRows.map((record) => record.id)],
      [tasks.conversationId, "bigint", taskRows.map((record) => record.conversationId)],
      [tasks.kind, "text", taskRows.map((record) => encodeIndexedString(record.kind))],
      [tasks.status, "text", taskRows.map((record) => record.state.status)],
      [tasks.abortRequested, "boolean", taskRows.map((record) => record.abortRequested)],
      [tasks.background, "boolean", taskRows.map((record) => record.background)],
      [tasks.record, "text", taskRows.map((record) => encodeJson(record))],
    ],
    upsert(tasks, [
      tasks.conversationId,
      tasks.kind,
      tasks.status,
      tasks.abortRequested,
      tasks.background,
      tasks.record,
    ]),
  );
  const submissionRows = plan.submissions;
  insert(
    "w_submissions",
    submissions,
    [
      [submissions.id, "bigint", submissionRows.map((record) => record.id)],
      [submissions.conversationId, "bigint", submissionRows.map((record) => record.conversationId)],
      [
        submissions.requestId,
        "text",
        submissionRows.map((record) => (record.requestId === undefined ? null : encodeIndexedString(record.requestId))),
      ],
      [submissions.status, "text", submissionRows.map((record) => record.status)],
      [submissions.record, "text", submissionRows.map((record) => encodeJson(record))],
    ],
    upsert(submissions, [submissions.conversationId, submissions.requestId, submissions.status, submissions.record]),
  );
  const documentRows = plan.documents;
  const parts = documentRows.map((record) => addressParts(record));
  insert(
    "w_documents",
    documents,
    [
      [documents.id, "bigint", documentRows.map((record) => record.id)],
      [documents.kind, "text", parts.map((part) => part.kind)],
      [documents.family, "smallint", parts.map((part) => part.family)],
      [documents.keyValue, "text", parts.map((part) => part.keyValue)],
      [documents.scopeKind, "text", parts.map((part) => part.scopeKind)],
      [documents.ownerId, "bigint", parts.map((part) => part.ownerId)],
      [documents.createdAt, "bigint", documentRows.map((record) => record.createdAt)],
      [documents.retiredAt, "bigint", documentRows.map((record) => record.retiredAt ?? null)],
      [documents.record, "text", documentRows.map((record) => encodeJson(record))],
    ],
    upsert(documents, [documents.retiredAt, documents.record]),
  );
  // The DELETE sees the statement's snapshot, so it cannot remove the revisions this statement inserts.
  if (plan.cleared.length > 0) {
    const r = alias(documentRevisions, "r");
    ctes.push(
      sql`w_cleared AS (DELETE FROM ${documentRevisions} AS ${r} USING guard g
        WHERE ${r.scopeId} = g.scope_id AND ${r.documentId} = ANY(${sql.param([...plan.cleared])}::bigint[]))`,
    );
  }
  const revisions = plan.revisions;
  insert("w_revisions", documentRevisions, [
    [documentRevisions.documentId, "bigint", revisions.map((revision) => revision.document)],
    [documentRevisions.seq, "bigint", revisions.map((revision) => revision.seq)],
    [documentRevisions.kind, "text", revisions.map((revision) => revision.kind)],
    [documentRevisions.version, "bigint", revisions.map((revision) => revision.version)],
    [documentRevisions.content, "text", revisions.map((revision) => revision.content)],
  ]);
  return sql`WITH ${sql.join(ctes, sql`,\n`)}\nSELECT count(*)::int AS stored FROM guard`;
}

async function writePlan(db: Database, scopeId: number, guard: CommitGuard, plan: CommitPlan): Promise<WriteOutcome> {
  const rows = await rowsOf<{ stored: unknown }>(db, planStatement(scopeId, guard, plan));
  if (toNumber(rows[0]?.stored ?? 0) === 1) return "stored";
  const scope = await db
    .select({
      leaseToken: scopes.leaseToken,
      held: sql<boolean>`${scopes.leaseExpiresAt} > clock_timestamp()`,
    })
    .from(scopes)
    .where(eq(scopes.scopeId, scopeId));
  const row = scope[0];
  if (row === undefined) return "deleted";
  if (row.leaseToken !== guard.leaseToken) return "taken";
  if (row.held !== true) return "expired";
  return "concurrent";
}
