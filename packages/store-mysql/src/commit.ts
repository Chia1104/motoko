// MySQL has no data-modifying CTEs or RETURNING, so the tables cannot share a statement, but they can share a round
// trip.

import type { DocumentCopySource, DocumentRecord, StoredDocument } from "@earendil-works/pi-durable";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { MySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";

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

import { fenced, freshNonce, isTransientError, now, packet, rowsOf } from "./database.ts";
import type { Database, PoolDatabase } from "./database.ts";
import {
  conversations,
  documentRevisions,
  documents,
  entries,
  INDEXED_LENGTHS,
  recordIds,
  scopes,
  submissions,
  tasks,
} from "./schema.ts";

export function commitPort(
  db: PoolDatabase,
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

/** mysql2 parses a JSON column. A pool with `jsonStrings` returns its text instead. */
const jsonValue = <T>(value: unknown, empty: T): T =>
  value === null || value === undefined ? empty : typeof value === "string" ? (JSON.parse(value) as T) : (value as T);

/** `scalar` when `values` is not empty, else NULL, because MySQL has no empty `IN ()`. */
const unlessEmpty = (values: readonly unknown[], scalar: () => SQL): SQL =>
  values.length === 0 ? sql`NULL` : scalar();

async function readCheckState(db: Database, scopeId: number, query: CheckQuery): Promise<CheckState | undefined> {
  const ids = unlessEmpty(
    query.ids,
    () => sql`(SELECT JSON_ARRAYAGG(JSON_ARRAY(${recordIds.id}, ${recordIds.recordType})) FROM ${recordIds}
      WHERE ${and(eq(recordIds.scopeId, scopeId), inArray(recordIds.id, [...query.ids]))})`,
  );
  const records = unlessEmpty(
    query.documents,
    () => sql`(SELECT JSON_ARRAYAGG(${documents.record}) FROM ${documents}
      WHERE ${and(eq(documents.scopeId, scopeId), inArray(documents.id, [...query.documents]))})`,
  );
  const versions = unlessEmpty(
    query.deltas,
    () => sql`(SELECT JSON_ARRAYAGG(JSON_ARRAY(q.id, (
        SELECT v.version FROM ${documentRevisions} AS v WHERE v.scope_id = ${scopeId} AND v.document_id = q.id
          ORDER BY v.seq DESC LIMIT 1)))
      FROM JSON_TABLE(${JSON.stringify(query.deltas)}, '$[*]' COLUMNS (id BIGINT PATH '$')) AS q)`,
  );
  const current = unlessEmpty(
    query.addresses,
    () => sql`(SELECT JSON_ARRAYAGG(JSON_ARRAY(${documents.id}, ${documents.kind}, ${documents.scopeKind},
        ${documents.ownerId}, ${documents.family}, ${documents.keyValue})) FROM ${documents}
      WHERE ${and(
        eq(documents.scopeId, scopeId),
        isNull(documents.retiredAt),
        or(
          ...query.addresses.map((part) =>
            and(
              eq(documents.kind, part.kind),
              eq(documents.scopeKind, part.scopeKind),
              eq(documents.ownerId, part.ownerId),
              eq(documents.family, part.family),
              eq(documents.keyValue, part.keyValue),
            ),
          ),
        ),
      )})`,
  );
  const [row] = await rowsOf<{
    next_id: unknown;
    next_seq: unknown;
    lease_token: unknown;
    ids: unknown;
    documents: unknown;
    versions: unknown;
    current: unknown;
  }>(
    db,
    sql`SELECT s.next_id, s.next_seq, s.lease_token, ${ids} AS ids, ${records} AS documents,
        ${versions} AS versions, ${current} AS current
      FROM ${scopes} AS s WHERE s.scope_id = ${scopeId}`,
  );
  if (row === undefined) return undefined;
  const claims = jsonValue<[number, RecordTable][]>(row.ids, []);
  const versionRows = jsonValue<[number, number | null][]>(row.versions, []);
  const currentRows = jsonValue<[number, string, ScopeKind, number, number, string][]>(row.current, []);
  const versionList: (readonly [number, number])[] = [];
  for (const [document, version] of versionRows) {
    if (version !== null) versionList.push([toNumber(document), toNumber(version)]);
  }
  return {
    nextId: toNumber(row.next_id),
    nextSeq: toNumber(row.next_seq),
    leaseToken: toNumber(row.lease_token),
    claims: claims.map(([claimed, table]) => [toNumber(claimed), table] as const),
    documents: jsonValue<string[]>(row.documents, []).map((text) => parseJson<DocumentRecord>(text)),
    versions: versionList,
    current: currentRows.map(([document, kind, scopeKind, ownerId, family, keyValue]) => {
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

/** A column too short for its value would reject it in a strict `sql_mode`, and truncate it in a lax one. */
function assertFits(value: string, length: number, what: string): void {
  if (value.length > length && [...value].length > length) {
    throw new Error(`${what} is too long for MySQL's index: at most ${length} characters of its JSON encoding`);
  }
}

type ScopedTable = MySqlTable & { scopeId: MySqlColumn };

function insertRows<R>(
  table: ScopedTable,
  scopeId: number,
  columns: readonly (readonly [column: MySqlColumn, value: (row: R) => unknown])[],
  rows: readonly R[],
  fence: SQL,
  update: readonly MySqlColumn[] = [],
): SQL | undefined {
  if (rows.length === 0) return undefined;
  const names = sql.join(
    [table.scopeId, ...columns.map(([column]) => column)].map((column) => sql.identifier(column.name)),
    sql`, `,
  );
  const values = sql.join(
    rows.map(
      (row) => sql`ROW(${sql.join([sql`${scopeId}`, ...columns.map(([, value]) => sql`${value(row)}`)], sql`, `)})`,
    ),
    sql`, `,
  );
  const upsert =
    update.length === 0
      ? sql``
      : sql` ON DUPLICATE KEY UPDATE ${sql.join(
          update.map((column) => sql`${sql.identifier(column.name)} = v.${sql.identifier(column.name)}`),
          sql`, `,
        )}`;
  return sql`INSERT INTO ${table} (${names}) SELECT * FROM (VALUES ${values}) AS v (${names}) WHERE ${fence}${upsert}`;
}

function planStatements(scopeId: number, plan: CommitPlan, fence: SQL): SQL[] {
  for (const task of plan.tasks) assertFits(encodeIndexedString(task.kind), INDEXED_LENGTHS.taskKind, "A task's kind");
  for (const submission of plan.submissions) {
    if (submission.requestId !== undefined) {
      assertFits(encodeIndexedString(submission.requestId), INDEXED_LENGTHS.requestId, "A submission's request ID");
    }
  }
  const parts = plan.documents.map((record) => addressParts(record));
  for (const part of parts) {
    assertFits(part.kind, INDEXED_LENGTHS.documentKind, "A document's kind");
    assertFits(part.keyValue, INDEXED_LENGTHS.documentKey, "A document's key");
  }
  const statements = [
    insertRows(
      recordIds,
      scopeId,
      [
        [recordIds.id, ([id]) => id],
        [recordIds.recordType, ([, table]) => table],
      ],
      plan.claims,
      fence,
    ),
    insertRows(
      conversations,
      scopeId,
      [
        [conversations.id, (record) => record.id],
        [conversations.ownerConversationId, (record) => record.owner?.conversationId ?? null],
        [conversations.ownerTaskId, (record) => record.owner?.taskId ?? null],
        [conversations.parentConversationId, (record) => record.parent?.conversationId ?? null],
        [conversations.parentAt, (record) => record.parent?.at ?? null],
        [conversations.record, (record) => encodeJson(record)],
      ],
      plan.conversations,
      fence,
    ),
    insertRows(
      entries,
      scopeId,
      [
        [entries.id, ({ record }) => record.id],
        [entries.conversationId, ({ record }) => record.conversationId],
        [entries.head, ({ record }) => record.head ?? null],
        [entries.commitSeq, ({ seq }) => seq],
        [entries.record, ({ record }) => encodeJson(record)],
      ],
      plan.entries,
      fence,
    ),
    insertRows(
      tasks,
      scopeId,
      [
        [tasks.id, (record) => record.id],
        [tasks.conversationId, (record) => record.conversationId],
        [tasks.kind, (record) => encodeIndexedString(record.kind)],
        [tasks.status, (record) => record.state.status],
        [tasks.abortRequested, (record) => record.abortRequested],
        [tasks.background, (record) => record.background],
        [tasks.record, (record) => encodeJson(record)],
      ],
      plan.tasks,
      fence,
      [tasks.conversationId, tasks.kind, tasks.status, tasks.abortRequested, tasks.background, tasks.record],
    ),
    insertRows(
      submissions,
      scopeId,
      [
        [submissions.id, (record) => record.id],
        [submissions.conversationId, (record) => record.conversationId],
        [
          submissions.requestId,
          (record) => (record.requestId === undefined ? null : encodeIndexedString(record.requestId)),
        ],
        [submissions.status, (record) => record.status],
        [submissions.record, (record) => encodeJson(record)],
      ],
      plan.submissions,
      fence,
      [submissions.conversationId, submissions.requestId, submissions.status, submissions.record],
    ),
    insertRows(
      documents,
      scopeId,
      [
        [documents.id, ({ record }) => record.id],
        [documents.kind, ({ part }) => part.kind],
        [documents.family, ({ part }) => part.family],
        [documents.keyValue, ({ part }) => part.keyValue],
        [documents.scopeKind, ({ part }) => part.scopeKind],
        [documents.ownerId, ({ part }) => part.ownerId],
        [documents.createdAt, ({ record }) => record.createdAt],
        [documents.retiredAt, ({ record }) => record.retiredAt ?? null],
        [documents.record, ({ record }) => encodeJson(record)],
      ],
      plan.documents.map((record, index) => ({ record, part: parts[index] as AddressParts })),
      fence,
      [documents.retiredAt, documents.record],
    ),
    plan.cleared.length === 0
      ? undefined
      : sql`DELETE FROM ${documentRevisions}
        WHERE ${and(eq(documentRevisions.scopeId, scopeId), inArray(documentRevisions.documentId, [...plan.cleared]))}
          AND ${fence}`,
    insertRows(
      documentRevisions,
      scopeId,
      [
        [documentRevisions.documentId, (revision) => revision.document],
        [documentRevisions.seq, (revision) => revision.seq],
        [documentRevisions.kind, (revision) => revision.kind],
        [documentRevisions.version, (revision) => revision.version],
        [documentRevisions.content, (revision) => revision.content],
      ],
      plan.revisions,
      fence,
    ),
  ];
  return statements.filter((statement) => statement !== undefined);
}

async function writePlan(
  db: PoolDatabase,
  scopeId: number,
  guard: CommitGuard,
  plan: CommitPlan,
): Promise<WriteOutcome> {
  const nonce = freshNonce();
  const writes = planStatements(scopeId, plan, fenced(scopeId, nonce));
  const results = await packet(db, [
    sql`UPDATE ${scopes} SET next_seq = ${guard.nextSeq}, next_id = GREATEST(next_id, ${guard.nextId}),
        commit_nonce = ${nonce}
      WHERE scope_id = ${scopeId} AND next_seq = ${guard.expectedSeq}
        AND lease_token = ${guard.leaseToken} AND lease_expires_at > ${now}`,
    ...writes,
    sql`SELECT CASE WHEN s.scope_id IS NULL THEN 'deleted'
        WHEN s.commit_nonce = ${nonce} THEN 'stored'
        WHEN s.lease_token <> ${guard.leaseToken} THEN 'taken'
        WHEN s.lease_expires_at > ${now} THEN 'concurrent'
        ELSE 'expired' END AS outcome
      FROM (SELECT 1) AS one LEFT JOIN ${scopes} AS s ON s.scope_id = ${scopeId}`,
  ]);
  const [row] = results.at(-1) as [{ outcome: WriteOutcome }];
  return row.outcome;
}
