import type { JsonValue } from "@earendil-works/chord/json";
import { StorageRequestError } from "@earendil-works/pi-durable";
import type {
  CommitResult,
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  Page,
  ScanOrder,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from "@earendil-works/pi-durable";
import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { StorageScope } from "@chia1104/motoko-core";
import {
  addressParts,
  encodeIndexedString,
  materializeDocument,
  parseJson,
  scopeColumns,
  seqFromNumber,
  StorageShell,
  toNumber,
} from "@chia1104/motoko-core/store";
import type { DocumentRows, FencedLease } from "@chia1104/motoko-core/store";

import { commitPort } from "./commit.ts";
import { rowsOf } from "./database.ts";
import type { Database } from "./database.ts";
import { journalCheck, missingJournalAsVersionError } from "./migrations.ts";
import { conversations, documentRevisions, documents, entries, scopes, submissions, tasks } from "./schema.ts";

type Context = Parameters<Storage["close"]>[0];
type AnyTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

const MAX_BIGINT = sql.raw("9223372036854775807");

const scanStart = (
  requested: ScanOrder | undefined,
  cursor: Cursor | undefined,
  fallback: ScanOrder,
): { order: ScanOrder; after: number | undefined } => {
  if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
    throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
  }
  if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
  const { after, order: stored } = cursor;
  if (typeof after !== "number" || !Number.isSafeInteger(after))
    throw new StorageRequestError("Invalid storage cursor");
  if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
    throw new StorageRequestError("Invalid storage cursor");
  }
  const order = (stored as ScanOrder | undefined) ?? fallback;
  if (requested !== undefined && requested !== order) {
    throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
  }
  return { order, after };
};

const cursorId = (cursor: Cursor | undefined): number | undefined => {
  const after = cursor?.after;
  if (after === undefined) return undefined;
  if (typeof after !== "number" || !Number.isSafeInteger(after))
    throw new StorageRequestError("Invalid storage cursor");
  return after;
};

const page = <T extends { readonly id: number }>(
  values: readonly T[],
  limit: number,
  order: ScanOrder = "ascending",
): Page<T, Cursor> => {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return { items, next: { after: (items.at(-1) as T).id, order } };
};

const scanBy = (column: PgColumn, start: { order: ScanOrder; after: number | undefined }) => ({
  where:
    start.after === undefined
      ? undefined
      : start.order === "ascending"
        ? gt(column, start.after)
        : lt(column, start.after),
  orderBy: start.order === "ascending" ? asc(column) : desc(column),
});

// A type alias, not an interface, because Drizzle's `execute` rows must satisfy `Record<string, unknown>`. Only an
// alias has the implicit index signature that this needs.
// oxlint-disable-next-line typescript/consistent-type-definitions
type DocumentRow = {
  record: string | null;
  base_version: unknown;
  base_content: string | null;
  tail_kinds: string[];
  tail_versions: unknown[];
  tail_contents: string[];
};

const documentRows = (row: DocumentRow): DocumentRows => ({
  record: row.record ?? undefined,
  base: row.base_content === null ? undefined : { version: toNumber(row.base_version), content: row.base_content },
  tail: row.tail_kinds.map((kind, index) => ({
    kind,
    version: toNumber(row.tail_versions[index]),
    content: row.tail_contents[index] as string,
  })),
});

export async function openStorage(db: Database, lease: FencedLease, attempts: number): Promise<PostgresStorage> {
  if (lease.signal.aborted) throw lease.signal.reason;
  const rows = await missingJournalAsVersionError(db, () =>
    rowsOf<{ applied: string[]; scope_id: unknown; next_id: unknown }>(
      db,
      sql`SELECT ${journalCheck.applied} AS applied, s.${sql.identifier(scopes.scopeId.name)} AS scope_id,
          s.${sql.identifier(scopes.nextId.name)} AS next_id
        FROM (SELECT 1) AS one LEFT JOIN ${scopes} AS s
          ON s.${sql.identifier(scopes.kind.name)} = ${lease.scope.kind}::text AND s.${sql.identifier(scopes.name.name)} = ${lease.scope.name}::text`,
    ),
  );
  const row = rows[0];
  journalCheck.assertCurrent(row?.applied);
  if (row === undefined || deletedSinceLeased(row.scope_id, lease)) {
    lease.lose("deleted");
    throw lease.signal.reason;
  }
  return new PostgresStorage(db, lease, toNumber(row.next_id), attempts);
}

const deletedSinceLeased = (scopeIdNow: unknown, lease: FencedLease): boolean =>
  scopeIdNow === null || toNumber(scopeIdNow) !== lease.scopeId;

/**
 * pi-durable Storage over one scope of the shared tables, fenced by the scope's lease. Open it with `store.storage()`.
 * It does not own the database. `close()` waits for its own calls to settle and leaves the pool open.
 */
class PostgresStorage implements Storage {
  readonly scope: StorageScope;
  readonly scopeId: number;
  readonly #db: Database;
  readonly #shell: StorageShell;

  constructor(db: Database, lease: FencedLease, nextId: number, attempts: number) {
    this.#db = db;
    this.scope = lease.scope;
    this.scopeId = lease.scopeId;
    const port = commitPort(db, lease.scopeId, (source) =>
      this.#documentRows(source.id, source.at).then((rows) => () => materializeDocument(rows, source.id, source.at)),
    );
    this.#shell = new StorageShell({ name: "PostgresStorage", lease, attempts, port, nextId });
  }

  /**
   * Store `batches` in two round trips: one statement reads the scope's counters and everything the checks need, the
   * checks run in memory, and one statement writes every accepted batch, guarded by the scope's `next_seq` and the
   * lease token. A batch with a document copy writes the batches before it and reads the copy's source first, which
   * costs one more round trip each. Only Durable's own checks refuse a batch. A database failure rejects the call.
   */
  commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
    _context: Context,
  ): Promise<CommitResult> {
    return this.#shell.commit(batches, receive);
  }

  /** Runs in memory. See `StorageShell.mintId`. */
  mintId<I extends Id<string>>(): Promise<I> {
    return this.#shell.mintId<I>();
  }

  conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    return this.#read(async () => {
      const rows = await this.#db
        .select({ record: conversations.record })
        .from(conversations)
        .where(and(eq(conversations.scopeId, this.scopeId), eq(conversations.id, id)));
      return rows[0] === undefined ? undefined : parseJson<ConversationRecord>(rows[0].record);
    });
  }

  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    return this.#read(async () => {
      const start = scanStart(query.order, cursor, "ascending");
      const scan = scanBy(conversations.id, start);
      const rows = await this.#db
        .select({ record: conversations.record })
        .from(conversations)
        .where(
          and(
            eq(conversations.scopeId, this.scopeId),
            scan.where,
            query.ownerConversationId === undefined
              ? undefined
              : eq(conversations.ownerConversationId, query.ownerConversationId),
            query.ownerTaskId === undefined ? undefined : eq(conversations.ownerTaskId, query.ownerTaskId),
          ),
        )
        .orderBy(scan.orderBy)
        .limit(limit + 1);
      return page(
        rows.map((row) => parseJson<ConversationRecord>(row.record)),
        limit,
        start.order,
      );
    });
  }

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    context?: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    return this.#read(async () => {
      if (context === undefined) {
        const rows = await this.#db
          .select({ record: entries.record, commitSeq: entries.commitSeq })
          .from(entries)
          .where(and(eq(entries.scopeId, this.scopeId), eq(entries.id, idOrConversationId)));
        const row = rows[0];
        return row === undefined
          ? undefined
          : { entry: parseJson<EntryRecord>(row.record), commitSeq: seqFromNumber(row.commitSeq) };
      }
      if (typeof idOrContext !== "number") throw new StorageRequestError("Storage.entry() requires an entry ID");
      const conversationId = idOrConversationId;
      const e = alias(entries, "e");
      const rows = await rowsOf<{ found: boolean; record: string | null; commit_seq: unknown; visible: boolean }>(
        this.#db,
        sql`${this.#chain(sql`${conversationId}::bigint`, sql`NULL::bigint`)}
          SELECT EXISTS (SELECT 1 FROM chain) AS found, ${e.record}, ${e.commitSeq},
            EXISTS (SELECT 1 FROM chain s WHERE s.conversation_id = ${e.conversationId}
              AND ${e.id} <= COALESCE(s.max_entry_id, ${MAX_BIGINT})) AS visible
          FROM (SELECT 1) AS one
            LEFT JOIN ${entries} AS ${e} ON ${e.scopeId} = ${this.scopeId}::bigint AND ${e.id} = ${idOrContext}::bigint`,
      );
      const row = rows[0];
      if (row === undefined || !row.found) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
      if (row.record === null || !row.visible) return undefined;
      return { entry: parseJson<EntryRecord>(row.record), commitSeq: seqFromNumber(toNumber(row.commit_seq)) };
    });
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.#read(async () => {
      const x = alias(entries, "x");
      const rows = await rowsOf<{ found: boolean; record: string | null }>(
        this.#db,
        sql`${this.#chain(sql`${conversationId}::bigint`, sql`${atOrBeforeEntryId ?? null}::bigint`)}
          SELECT EXISTS (SELECT 1 FROM chain) AS found, (
            SELECT e.record FROM chain s CROSS JOIN LATERAL (
              SELECT ${x.id}, ${x.record} FROM ${entries} AS ${x}
                WHERE ${x.scopeId} = ${this.scopeId}::bigint AND ${x.conversationId} = s.conversation_id
                AND ${x.head} IS NOT NULL AND ${x.id} <= COALESCE(s.max_entry_id, ${MAX_BIGINT})
                ORDER BY ${x.id} DESC LIMIT 1
            ) e ORDER BY s.distance LIMIT 1
          ) AS record`,
      );
      const row = rows[0];
      if (row === undefined || !row.found) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
      return row.record === null ? undefined : parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
    });
  }

  /**
   * One statement reads the fork chain with a recursive CTE and, per segment, its entries in index order up to the
   * limit with `LATERAL ... LIMIT`. It concatenates the segments in order, the child first for a descending scan and
   * the root first for an ascending one. Upstream's SQLite storage walks them in the same order, one query per segment.
   */
  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.#read(async () => {
      const { order, after } = scanStart(query.order, cursor, "descending");
      const min = query.minEntryId;
      let upper: number | undefined = query.maxEntryId;
      let lower: number | undefined = min;
      if (order === "descending") {
        if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
      } else if (after !== undefined) {
        lower = Math.max(lower ?? after + 1, after + 1);
      }
      const chain = this.#chain(
        sql`${query.conversationId}::bigint`,
        sql`${upper ?? null}::bigint`,
        min === undefined ? undefined : sql`${min}::bigint`,
      );
      const x = alias(entries, "x");
      const bound = lower === undefined ? sql`` : sql` AND ${x.id} >= ${lower}::bigint`;
      const direction = order === "descending" ? sql`DESC` : sql`ASC`;
      const segments = order === "descending" ? sql`ASC` : sql`DESC`;
      const rows = await rowsOf<{ found: boolean; records: string[] }>(
        this.#db,
        sql`${chain}
          SELECT EXISTS (SELECT 1 FROM chain) AS found, ARRAY(
            SELECT e.record FROM chain s CROSS JOIN LATERAL (
              SELECT ${x.id}, ${x.record} FROM ${entries} AS ${x}
                WHERE ${x.scopeId} = ${this.scopeId}::bigint AND ${x.conversationId} = s.conversation_id
                AND ${x.id} <= COALESCE(s.max_entry_id, ${MAX_BIGINT})${bound}
                ORDER BY ${x.id} ${direction} LIMIT ${limit + 1}::bigint
            ) e ORDER BY s.distance ${segments}, e.id ${direction} LIMIT ${limit + 1}::bigint
          ) AS records`,
      );
      const row = rows[0];
      if (row === undefined || !row.found) {
        throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
      }
      return page(
        row.records.map((record) => parseJson<EntryRecord>(record)),
        limit,
        order,
      );
    });
  }

  task(id: TaskId, _context: Context): Promise<AnyTask | undefined> {
    return this.#read(async () => {
      const rows = await this.#db
        .select({ record: tasks.record })
        .from(tasks)
        .where(and(eq(tasks.scopeId, this.scopeId), eq(tasks.id, id)));
      return rows[0] === undefined ? undefined : parseJson<AnyTask>(rows[0].record);
    });
  }

  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<AnyTask, Cursor>> {
    return this.#read(async () => {
      const start = scanStart(query.order, cursor, "ascending");
      const scan = scanBy(tasks.id, start);
      const rows = await this.#db
        .select({ record: tasks.record })
        .from(tasks)
        .where(
          and(
            eq(tasks.scopeId, this.scopeId),
            scan.where,
            query.conversationId === undefined ? undefined : eq(tasks.conversationId, query.conversationId),
            query.kind === undefined ? undefined : eq(tasks.kind, encodeIndexedString(query.kind)),
            query.status === undefined ? undefined : eq(tasks.status, query.status),
            query.abortRequested === undefined ? undefined : eq(tasks.abortRequested, query.abortRequested),
            query.background === undefined ? undefined : eq(tasks.background, query.background),
          ),
        )
        .orderBy(scan.orderBy)
        .limit(limit + 1);
      return page(
        rows.map((row) => parseJson<AnyTask>(row.record)),
        limit,
        start.order,
      );
    });
  }

  submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    return this.#read(async () => {
      const rows = await this.#db
        .select({ record: submissions.record })
        .from(submissions)
        .where(and(eq(submissions.scopeId, this.scopeId), eq(submissions.id, id)));
      return rows[0] === undefined ? undefined : parseJson<SubmissionRecord>(rows[0].record);
    });
  }

  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return this.#read(async () => {
      const start = scanStart(query.order, cursor, "ascending");
      const scan = scanBy(submissions.id, start);
      const rows = await this.#db
        .select({ record: submissions.record })
        .from(submissions)
        .where(
          and(
            eq(submissions.scopeId, this.scopeId),
            scan.where,
            query.conversationId === undefined ? undefined : eq(submissions.conversationId, query.conversationId),
            query.status === undefined ? undefined : eq(submissions.status, query.status),
          ),
        )
        .orderBy(scan.orderBy)
        .limit(limit + 1);
      return page(
        rows.map((row) => parseJson<SubmissionRecord>(row.record)),
        limit,
        start.order,
      );
    });
  }

  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.#read(async () => {
      const rows = await this.#db
        .select({ record: submissions.record })
        .from(submissions)
        .where(
          and(
            eq(submissions.scopeId, this.scopeId),
            eq(submissions.conversationId, conversationId),
            eq(submissions.requestId, encodeIndexedString(requestId)),
          ),
        )
        .orderBy(asc(submissions.id))
        .limit(1);
      return rows[0] === undefined ? undefined : parseJson<SubmissionRecord>(rows[0].record);
    });
  }

  /**
   * One statement reads the document's record and its content at the same point, as `document()` reads it. The shell
   * keeps the content for the `document()` call that usually follows. A current address found empty is not read again
   * until the next commit.
   */
  findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
    return this.#shell.findDocument(address, at, async () => {
      const parts = addressParts(address);
      const scopeId = sql`${this.scopeId}::bigint`;
      const upTo = at === "current" ? MAX_BIGINT : sql`${at}::bigint`;
      const r = alias(documentRevisions, "r");
      const rows = await rowsOf<DocumentRow>(
        this.#db,
        sql`WITH d AS (
            SELECT ${documents.id} AS id, ${documents.record} AS record FROM ${documents}
              WHERE ${and(
                eq(documents.scopeId, this.scopeId),
                eq(documents.kind, parts.kind),
                eq(documents.scopeKind, parts.scopeKind),
                eq(documents.ownerId, parts.ownerId),
                eq(documents.family, parts.family),
                eq(documents.keyValue, parts.keyValue),
                aliveAt(at),
              )}
              ORDER BY ${documents.createdAt} DESC LIMIT 1
          ), b AS (
            SELECT ${r.seq} AS seq, ${r.version} AS version, ${r.content} AS content FROM ${documentRevisions} AS ${r}, d
              WHERE ${r.scopeId} = ${scopeId} AND ${r.documentId} = d.id AND ${r.kind} = 'base' AND ${r.seq} <= ${upTo}
              ORDER BY ${r.seq} DESC LIMIT 1
          ), tail AS (
            SELECT ${r.seq} AS seq, ${r.kind} AS kind, ${r.version} AS version, ${r.content} AS content
              FROM ${documentRevisions} AS ${r}, d, b
              WHERE ${r.scopeId} = ${scopeId} AND ${r.documentId} = d.id AND ${r.seq} > b.seq AND ${r.seq} <= ${upTo}
          )
          SELECT (SELECT record FROM d) AS record,
            (SELECT version FROM b) AS base_version, (SELECT content FROM b) AS base_content,
            ARRAY(SELECT kind FROM tail ORDER BY seq) AS tail_kinds,
            ARRAY(SELECT version FROM tail ORDER BY seq) AS tail_versions,
            ARRAY(SELECT content FROM tail ORDER BY seq) AS tail_contents`,
      );
      const row = rows[0];
      return row === undefined ? undefined : documentRows(row);
    });
  }

  /**
   * Costs one statement, or none when `findDocument` just read the same document at the same point and nothing was
   * committed since.
   */
  document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    return this.#shell.document(id, at, () => this.#documentRows(id, at));
  }

  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.#read(async () => {
      const scope = scopeColumns(query.scope);
      const rows = await this.#db
        .select({ record: documents.record })
        .from(documents)
        .where(
          and(
            eq(documents.scopeId, this.scopeId),
            eq(documents.scopeKind, scope.scopeKind),
            eq(documents.ownerId, scope.ownerId),
            gt(documents.id, cursorId(cursor) ?? -1),
            query.kind === undefined ? undefined : eq(documents.kind, encodeIndexedString(query.kind)),
            aliveAt(query.at),
          ),
        )
        .orderBy(asc(documents.id))
        .limit(limit + 1);
      return page(
        rows.map((row) => parseJson<DocumentRecord>(row.record)),
        limit,
      );
    });
  }

  /** Stops accepting calls and resolves once the calls already running settled. Leaves the database open. */
  close(_context: Context): Promise<void> {
    return this.#shell.close();
  }

  #chain(conversation: SQL, maxEntryId: SQL, minEntryId?: SQL): SQL {
    const c = alias(conversations, "c");
    const scopeId = sql`${this.scopeId}::bigint`;
    const parentMax = sql`LEAST(ch.max_entry_id, ch.parent_at)`;
    const reachesMin = minEntryId === undefined ? sql`` : sql`WHERE ${parentMax} >= ${minEntryId}`;
    return sql`WITH RECURSIVE chain AS (
        SELECT 0 AS distance, ${c.id} AS conversation_id, ${maxEntryId} AS max_entry_id,
          ${c.parentConversationId} AS parent_conversation_id, ${c.parentAt} AS parent_at
          FROM ${conversations} AS ${c} WHERE ${c.scopeId} = ${scopeId} AND ${c.id} = ${conversation}
        UNION ALL
        SELECT ch.distance + 1, ${c.id}, ${parentMax}, ${c.parentConversationId}, ${c.parentAt}
          FROM chain ch JOIN ${conversations} AS ${c} ON ${c.scopeId} = ${scopeId} AND ${c.id} = ch.parent_conversation_id
          ${reachesMin}
      )`;
  }

  async #documentRows(id: number, at: DocumentPoint): Promise<DocumentRows> {
    const r = alias(documentRevisions, "r");
    const scopeId = sql`${this.scopeId}::bigint`;
    const document = sql`${id}::bigint`;
    const upTo = at === "current" ? MAX_BIGINT : sql`${at}::bigint`;
    const rows = await rowsOf<DocumentRow>(
      this.#db,
      sql`WITH b AS (
          SELECT ${documentRevisions.seq}, ${documentRevisions.version}, ${documentRevisions.content}
            FROM ${documentRevisions}
            WHERE ${documentRevisions.scopeId} = ${scopeId} AND ${documentRevisions.documentId} = ${document}
            AND ${documentRevisions.kind} = 'base' AND ${documentRevisions.seq} <= ${upTo}
            ORDER BY ${documentRevisions.seq} DESC LIMIT 1
        ), tail AS (
          SELECT ${r.seq}, ${r.kind}, ${r.version}, ${r.content} FROM ${documentRevisions} AS ${r}, b
            WHERE ${r.scopeId} = ${scopeId} AND ${r.documentId} = ${document} AND ${r.seq} > b.seq AND ${r.seq} <= ${upTo}
        )
        SELECT (SELECT ${documents.record} FROM ${documents}
            WHERE ${documents.scopeId} = ${scopeId} AND ${documents.id} = ${document}) AS record,
          (SELECT version FROM b) AS base_version, (SELECT content FROM b) AS base_content,
          ARRAY(SELECT kind FROM tail ORDER BY seq) AS tail_kinds,
          ARRAY(SELECT version FROM tail ORDER BY seq) AS tail_versions,
          ARRAY(SELECT content FROM tail ORDER BY seq) AS tail_contents`,
    );
    return documentRows(rows[0] as DocumentRow);
  }

  #read<T>(read: () => Promise<T>): Promise<T> {
    return this.#shell.read(read);
  }
}

function aliveAt(at: DocumentPoint): SQL | undefined {
  if (at === "current") return isNull(documents.retiredAt);
  return and(lte(documents.createdAt, at), or(isNull(documents.retiredAt), gt(documents.retiredAt, at)));
}

export type { PostgresStorage };
