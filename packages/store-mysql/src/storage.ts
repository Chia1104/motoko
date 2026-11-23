// pi-durable `Storage` on MySQL, one scope of the shared tables. Ported from pi-durable 1.6.0's SQLite storage
// (`storage/sqlite/storage.js`) as store-postgres ports it: every query restricted to the scope's `scope_id`,
// multi-query reads folded into single statements (a recursive CTE walks a fork's ancestry, a LATERAL derived table
// reads each segment), and commits through the shared commit protocol. What is not SQL is core's `StorageShell`.

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
import type { MySqlColumn } from "drizzle-orm/mysql-core";

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
import { MAX_BIGINT, rowsOf, UNBOUNDED } from "./database.ts";
import type { PoolDatabase } from "./database.ts";
import { journalCheck, withJournal } from "./migrations.ts";
import { conversations, documentRevisions, documents, entries, scopes, submissions, tasks } from "./schema.ts";

type Context = Parameters<Storage["close"]>[0];
type AnyTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

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

/** The id range and order of a scan over `id`. */
const scanBy = (column: MySqlColumn, start: { order: ScanOrder; after: number | undefined }) => ({
  where:
    start.after === undefined
      ? undefined
      : start.order === "ascending"
        ? gt(column, start.after)
        : lt(column, start.after),
  orderBy: start.order === "ascending" ? asc(column) : desc(column),
});

// A type alias, not an interface: Drizzle's `execute` rows must satisfy `Record<string, unknown>`, and only an alias
// has the implicit index signature that takes.
// oxlint-disable-next-line typescript/consistent-type-definitions
type RevisionRow = { record: string; kind: string | null; version: unknown; content: string | null };

/** A document read's rows, the base first and its tail after it, as the shell's `DocumentRows`. */
const documentRowsOf = (rows: readonly RevisionRow[]): DocumentRows => {
  const [base, ...tail] = rows.filter((row) => row.kind !== null);
  return {
    record: rows[0]?.record,
    base: base === undefined ? undefined : { version: toNumber(base.version), content: base.content as string },
    tail: tail.map((row) => ({
      kind: row.kind as string,
      version: toNumber(row.version),
      content: row.content as string,
    })),
  };
};

/**
 * pi-durable Storage over one scope of the shared tables, fenced by the scope's lease. Open it with
 * `store.storage()`. It does not own the database: `close()` waits for its own calls to settle and leaves the pool
 * open.
 */
export class MysqlStorage implements Storage {
  readonly scope: StorageScope;
  readonly scopeId: number;
  readonly #db: PoolDatabase;
  readonly #shell: StorageShell;

  private constructor(
    db: PoolDatabase,
    scope: StorageScope,
    scopeId: number,
    nextId: number,
    lease: FencedLease,
    attempts: number,
  ) {
    this.#db = db;
    this.scope = scope;
    this.scopeId = scopeId;
    const port = commitPort(db, scopeId, (source) =>
      this.#documentRows(source.id, source.at).then((rows) => () => materializeDocument(rows, source.id, source.at)),
    );
    this.#shell = new StorageShell({ name: "MysqlStorage", lease, attempts, port, nextId });
  }

  /**
   * @internal Use `store.storage()`. One round trip: the schema check and the scope row's counters, read together.
   * The lease created the row; a row that is gone means the scope was deleted since the lease was acquired (a scope
   * created again has another `scope_id`).
   */
  static async open(db: PoolDatabase, lease: FencedLease, attempts: number): Promise<MysqlStorage> {
    if (lease.signal.aborted) throw lease.signal.reason;
    const [row] = await withJournal(db, () =>
      rowsOf<{ applied: unknown; next_id: unknown }>(
        db,
        sql`SELECT ${journalCheck.applied} AS applied, s.next_id
          FROM (SELECT 1) AS one LEFT JOIN ${scopes} AS s ON s.scope_id = ${lease.scopeId}`,
      ),
    );
    journalCheck.assertCurrent(row?.applied);
    if (row === undefined || row.next_id === null) {
      lease.lose("deleted");
      throw lease.signal.reason;
    }
    return new MysqlStorage(db, lease.scope, lease.scopeId, toNumber(row.next_id), lease, attempts);
  }

  /**
   * Store `batches` in two round trips: one statement reads the scope's counters and everything the checks need, the
   * checks run in memory, and one transaction sent as one multi-statement query writes every accepted batch, its guard
   * first (see `commit.ts`). A batch with a document copy writes the batches before it and reads the copy's source
   * first: two more round trips.
   */
  commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
    _context: Context,
  ): Promise<CommitResult> {
    return this.#shell.commit(batches, receive);
  }

  /** In memory: see `StorageShell.mintId`. */
  mintId<I extends Id<string>>(): Promise<I> {
    return this.#shell.mintId<I>();
  }

  conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    return this.#shell.read(async () => {
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
    return this.#shell.read(async () => {
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
    return this.#shell.read(async () => {
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
      const [row] = await rowsOf<{ found: unknown; record: string | null; commit_seq: unknown; visible: unknown }>(
        this.#db,
        sql`${this.#chain(conversationId, undefined)}
          SELECT ${UNBOUNDED} EXISTS (SELECT 1 FROM chain) AS found, e.record, e.commit_seq,
            EXISTS (SELECT 1 FROM chain AS s WHERE s.conversation_id = e.conversation_id
              AND e.id <= COALESCE(s.upper, ${MAX_BIGINT})) AS visible
          FROM (SELECT 1) AS one
            LEFT JOIN ${entries} AS e ON e.scope_id = ${this.scopeId} AND e.id = ${idOrContext}`,
      );
      if (row === undefined || Number(row.found) !== 1) {
        throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
      }
      if (row.record === null || Number(row.visible) !== 1) return undefined;
      return { entry: parseJson<EntryRecord>(row.record), commitSeq: seqFromNumber(toNumber(row.commit_seq)) };
    });
  }

  /**
   * One statement: per segment of the fork chain, its latest head marker at or below the segment's cap (one index
   * lookup each), and the first segment's that has one. A correlated subquery, not a LATERAL join: MySQL 8.4 plans
   * `chain JOIN LATERAL (... LIMIT 1) ORDER BY ord LIMIT 1` by keeping one chain row before the join, so a marker
   * beyond the first segment is never found.
   */
  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.#shell.read(async () => {
      const [row] = await rowsOf<{ found: unknown; record: string | null }>(
        this.#db,
        sql`${this.#chain(conversationId, atOrBeforeEntryId)}
          SELECT ${UNBOUNDED} EXISTS (SELECT 1 FROM chain) AS found, (
            SELECT m.record FROM (
              SELECT s.ord, (
                SELECT x.record FROM ${entries} AS x
                  WHERE x.scope_id = ${this.scopeId} AND x.conversation_id = s.conversation_id
                    AND x.marker_id <= COALESCE(s.upper, ${MAX_BIGINT})
                  ORDER BY x.marker_id DESC LIMIT 1
              ) AS record FROM chain AS s
            ) AS m WHERE m.record IS NOT NULL ORDER BY m.ord LIMIT 1
          ) AS record`,
      );
      if (row === undefined || Number(row.found) !== 1) {
        throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
      }
      return row.record === null ? undefined : parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
    });
  }

  /**
   * One statement: the fork chain (recursive CTE) and, per segment, its entries in index order up to the limit
   * (`LATERAL ... LIMIT`), concatenated in segment order: the child first for a descending scan, the root first for
   * an ascending one, exactly as upstream's SQLite storage walks them query by query. The page's ORDER BY names the
   * entry's id beside the segment, so MySQL sorts after the join (see `findLatestHeadMarker`).
   */
  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.#shell.read(async () => {
      const { order, after } = scanStart(query.order, cursor, "descending");
      const min = query.minEntryId;
      let upper: number | undefined = query.maxEntryId;
      let lower: number | undefined = min;
      if (order === "descending") {
        if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
      } else if (after !== undefined) {
        lower = Math.max(lower ?? after + 1, after + 1);
      }
      const bound = lower === undefined ? sql`` : sql` AND x.id >= ${lower}`;
      const direction = order === "descending" ? sql`DESC` : sql`ASC`;
      const segments = order === "descending" ? sql`ASC` : sql`DESC`;
      const rows = await rowsOf<{ found: unknown; record: string | null }>(
        this.#db,
        sql`${this.#chain(query.conversationId, upper, min)}
          SELECT ${UNBOUNDED} f.found, p.record
          FROM (SELECT EXISTS (SELECT 1 FROM chain) AS found) AS f LEFT JOIN (
            SELECT s.ord, e.id, e.record FROM chain AS s JOIN LATERAL (
              SELECT x.id, x.record FROM ${entries} AS x
                WHERE x.scope_id = ${this.scopeId} AND x.conversation_id = s.conversation_id
                  AND x.id <= COALESCE(s.upper, ${MAX_BIGINT})${bound}
                ORDER BY x.id ${direction} LIMIT ${limit + 1}
            ) AS e ON TRUE
            ORDER BY s.ord ${segments}, e.id ${direction} LIMIT ${limit + 1}
          ) AS p ON TRUE
          ORDER BY p.ord ${segments}, p.id ${direction}`,
      );
      if (rows[0] === undefined || Number(rows[0].found) !== 1) {
        throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
      }
      return page(
        rows.flatMap((row) => (row.record === null ? [] : [parseJson<EntryRecord>(row.record)])),
        limit,
        order,
      );
    });
  }

  task(id: TaskId, _context: Context): Promise<AnyTask | undefined> {
    return this.#shell.read(async () => {
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
    return this.#shell.read(async () => {
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
    return this.#shell.read(async () => {
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
    return this.#shell.read(async () => {
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
    return this.#shell.read(async () => {
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
   * One statement: the document's record and, beside it, its content at the same point (as `document()` reads it),
   * which the shell keeps for the `document()` call that usually follows. A current address found empty costs nothing
   * again until the next commit.
   */
  findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
    return this.#shell.findDocument(address, at, async () => {
      const parts = addressParts(address);
      const rows = await this.#revisionRows(
        sql`SELECT ${documents.id}, ${documents.record} FROM ${documents}
          WHERE ${and(
            eq(documents.scopeId, this.scopeId),
            eq(documents.kind, parts.kind),
            eq(documents.scopeKind, parts.scopeKind),
            eq(documents.ownerId, parts.ownerId),
            eq(documents.family, parts.family),
            eq(documents.keyValue, parts.keyValue),
            aliveAt(at),
          )}
          ORDER BY ${documents.createdAt} DESC LIMIT 1`,
        at,
      );
      return rows.length === 0 ? undefined : documentRowsOf(rows);
    });
  }

  /**
   * One statement, or none right after `findDocument` read the same document at the same point with nothing committed
   * since.
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
    return this.#shell.read(async () => {
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

  /**
   * The fork chain of `conversation` as the CTE `chain(ord, conversation_id, upper, ...)`: the conversation itself
   * (`ord` 0) capped at `upper`, then each ancestor capped at the lowest fork point below it. With `min`, the walk
   * stops at the first ancestor whose cap falls below it, as upstream's scans do. MySQL's `LEAST` is NULL when any
   * argument is, so an uncapped segment's cap is its fork point alone.
   */
  #chain(conversation: number, upper: number | undefined, min?: number): SQL {
    const cap = sql`LEAST(COALESCE(ch.upper, ch.parent_at), ch.parent_at)`;
    return sql`WITH RECURSIVE chain (ord, conversation_id, upper, parent_conversation_id, parent_at) AS (
        SELECT 0, c.id, CAST(${upper ?? null} AS SIGNED), c.parent_conversation_id, c.parent_at
          FROM ${conversations} AS c WHERE c.scope_id = ${this.scopeId} AND c.id = ${conversation}
        UNION ALL
        SELECT ch.ord + 1, c.id, ${cap}, c.parent_conversation_id, c.parent_at
          FROM chain AS ch JOIN ${conversations} AS c ON c.scope_id = ${this.scopeId} AND c.id = ch.parent_conversation_id
          ${min === undefined ? sql`` : sql`WHERE ${cap} >= ${min}`}
      )`;
  }

  /** A document's record, newest base at or before `at`, and the deltas after it, in one statement (one snapshot). */
  async #documentRows(id: number, at: DocumentPoint): Promise<DocumentRows> {
    const rows = await this.#revisionRows(
      sql`SELECT ${documents.id}, ${documents.record} FROM ${documents}
        WHERE ${and(eq(documents.scopeId, this.scopeId), eq(documents.id, id))}`,
      at,
    );
    return documentRowsOf(rows);
  }

  /**
   * One row per revision the content of the document `selected` finds (a derived table of its `id` and `record`) is
   * built from at `at`: its newest base at or before `at`, then the deltas after it, each beside the record. One row
   * with no revision when it has no base; none when there is no such document.
   */
  #revisionRows(selected: SQL, at: DocumentPoint): Promise<RevisionRow[]> {
    const upTo = at === "current" ? MAX_BIGINT : sql`${at}`;
    return rowsOf<RevisionRow>(
      this.#db,
      sql`SELECT d.record, r.kind, r.version, r.content
        FROM (${selected}) AS d
          LEFT JOIN LATERAL (
            SELECT b.seq FROM ${documentRevisions} AS b
              WHERE b.scope_id = ${this.scopeId} AND b.document_id = d.id AND b.kind = 'base' AND b.seq <= ${upTo}
              ORDER BY b.seq DESC LIMIT 1
          ) AS base ON TRUE
          LEFT JOIN ${documentRevisions} AS r
            ON r.scope_id = ${this.scopeId} AND r.document_id = d.id AND r.seq >= base.seq AND r.seq <= ${upTo}
        ORDER BY r.seq`,
    );
  }
}

/** Alive at `at`: current (not retired), or created at or before the seq and not yet retired at it. */
function aliveAt(at: DocumentPoint): SQL | undefined {
  if (at === "current") return isNull(documents.retiredAt);
  return and(lte(documents.createdAt, at), or(isNull(documents.retiredAt), gt(documents.retiredAt, at)));
}
