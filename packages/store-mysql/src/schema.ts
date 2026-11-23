/**
 * Motoko's tables, as a Drizzle schema, in the database the app's pool connects to, each named `agent_runtime_*`.
 * Every scope (agent instance) shares them: a new scope is one row in `agent_runtime_scopes`, never DDL. Every other
 * table is keyed by `scope_id` first and cascades from the scope's row, so deleting it deletes everything it owns.
 *
 * An app may import this module (`@chia1104/motoko-store-mysql/schema`) to read the runtime's tables with its own Drizzle
 * instance. Motoko writes them: an app that writes them bypasses the storage's checks and its lease.
 *
 * Changing this file needs a new migration: `pnpm db:generate` writes it to `migrations/`. Never edit a released
 * migration.
 *
 * - Records are JSON in `LONGTEXT` columns, not `JSON`: MySQL's JSON type rewrites the text (key order, numbers) and
 *   `TEXT` holds only 64 KB.
 * - Indexed strings hold the JSON encoding of the string (so lone surrogates survive) in `utf8mb4_0900_bin` columns,
 *   which order and compare by the bytes of their UTF-8 encoding and pad nothing, as pi-durable's SQLite storage
 *   does. An index key holds at most 3072 bytes, 4 per character, so each indexed string has the length its indexes
 *   leave it, counted in characters of its JSON encoding.
 * - A scope's kind and name hold up to 1024 characters each, more than an index key: their unique key is the SHA-256
 *   of the two, a generated column.
 * - Times of the database clock are `DATETIME(3)` in UTC (`UTC_TIMESTAMP(3)`), which no session `time_zone` converts.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  binary,
  boolean,
  check,
  datetime,
  foreignKey,
  index,
  longtext,
  mysqlTableCreator,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";

/** Every table's name: `agent_runtime_<name>`, beside the app's own tables in its database. */
export const runtimeTable = mysqlTableCreator((name) => `agent_runtime_${name}`);

/** The most characters of each indexed string's JSON encoding that its indexes leave room for. */
export const INDEXED_LENGTHS = {
  taskKind: 760,
  requestId: 760,
  documentKind: 256,
  documentKey: 500,
} as const;

/** `utf8mb4_0900_bin`: byte order and byte equality, no trailing-space padding, whatever the database's default. */
const exact = (name: string, length: number) =>
  varchar(name, { length }).charSet("utf8mb4").collate("utf8mb4_0900_bin");

/** A label from a fixed set, which a CHECK constraint names. */
const label = (name: string, length: number) => varchar(name, { length }).charSet("ascii").collate("ascii_bin");

/** A record's JSON text. */
const json = (name: string) => longtext(name).charSet("utf8mb4").collate("utf8mb4_bin");

/** Integers the runtime stores are at most 2^53 (IDs and seqs are safe integers), so they read back as `number`. */
const int8 = (name: string) => bigint(name, { mode: "number" });

/**
 * One row per scope. `next_id` / `next_seq` are the scope's ID and commit-sequence counters; `lease_*` is its
 * single-writer lease: holder label, expiry by the database clock (UTC), and a fencing token that increases with every
 * acquisition. `wake_*` is what the scope's last holder left as it released the lease (pi-durable's `Wake`: work that
 * can run, and the earliest sleep, in epoch ms on the Harness clock): with a holder that never released it, what makes
 * a scope one `unfinished()` lists, as the generated `unfinished` column says. `commit_nonce` is the random value the
 * last fenced transaction (a commit, an erase, an acquisition of the lease) stamped on the row with its first
 * statement; its later statements write only where the row holds it.
 */
export const scopes = runtimeTable(
  "scopes",
  {
    scopeId: int8("scope_id").autoincrement().primaryKey(),
    kind: exact("kind", 1024).notNull(),
    name: exact("name", 1024).notNull(),
    /** SHA-256 of the kind's UTF-8, a NUL, and the name's UTF-8: no part holds a NUL. */
    scopeKey: binary("scope_key", { length: 32 })
      .notNull()
      .generatedAlwaysAs(sql`unhex(sha2(concat(\`kind\`, x'00', \`name\`), 256))`, { mode: "stored" }),
    nextId: int8("next_id").notNull().default(2),
    nextSeq: int8("next_seq").notNull().default(1),
    leaseToken: int8("lease_token").notNull().default(0),
    leaseHolder: text("lease_holder").charSet("utf8mb4").collate("utf8mb4_bin"),
    leaseExpiresAt: datetime("lease_expires_at", { fsp: 3 }),
    wakeActive: boolean("wake_active").notNull().default(false),
    wakeAt: int8("wake_at"),
    unfinished: boolean("unfinished")
      .notNull()
      .generatedAlwaysAs(sql`(\`wake_active\` or \`wake_at\` is not null or \`lease_holder\` is not null)`, {
        mode: "virtual",
      }),
    createdAt: datetime("created_at", { fsp: 3 })
      .notNull()
      .default(sql`(utc_timestamp(3))`),
    commitNonce: binary("commit_nonce", { length: 16 }),
  },
  (t) => [uniqueIndex("scopes_scope_key").on(t.scopeKey), index("scopes_unfinished").on(t.unfinished, t.scopeId)],
);

const scopeIdColumn = () => int8("scope_id").notNull();
/** Every table but `scopes` cascades from the scope's row. */
const ownedBy = (name: string, scopeId: AnyMySqlColumn) =>
  foreignKey({ name: `${name}_scope`, columns: [scopeId], foreignColumns: [scopes.scopeId] }).onDelete("cascade");

/** Every claimed record ID of a scope and the table that claimed it. */
export const recordIds = runtimeTable(
  "record_ids",
  {
    scopeId: scopeIdColumn(),
    id: int8("id").notNull(),
    recordType: label("record_type", 12).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    ownedBy("record_ids", t.scopeId),
    check(
      "record_ids_record_type",
      sql`${t.recordType} IN ('conversation', 'entry', 'task', 'submission', 'document')`,
    ),
  ],
);

export const conversations = runtimeTable(
  "conversations",
  {
    scopeId: scopeIdColumn(),
    id: int8("id").notNull(),
    ownerConversationId: int8("owner_conversation_id"),
    ownerTaskId: int8("owner_task_id"),
    parentConversationId: int8("parent_conversation_id"),
    parentAt: int8("parent_at"),
    record: json("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    ownedBy("conversations", t.scopeId),
    index("conversations_by_owner_conversation").on(t.scopeId, t.ownerConversationId, t.id),
    index("conversations_by_owner_task").on(t.scopeId, t.ownerTaskId, t.id),
  ],
);

/**
 * `marker_id` is the entry's id when it is a head marker and NULL otherwise, so a range on its index visits head
 * markers only (Postgres's partial index).
 */
export const entries = runtimeTable(
  "entries",
  {
    scopeId: scopeIdColumn(),
    id: int8("id").notNull(),
    conversationId: int8("conversation_id").notNull(),
    head: int8("head"),
    markerId: int8("marker_id").generatedAlwaysAs(sql`(if(\`head\` is null, null, \`id\`))`, { mode: "virtual" }),
    commitSeq: int8("commit_seq").notNull(),
    record: json("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    ownedBy("entries", t.scopeId),
    index("entries_by_conversation").on(t.scopeId, t.conversationId, t.id),
    index("entry_heads_by_conversation").on(t.scopeId, t.conversationId, t.markerId),
  ],
);

export const tasks = runtimeTable(
  "tasks",
  {
    scopeId: scopeIdColumn(),
    id: int8("id").notNull(),
    conversationId: int8("conversation_id").notNull(),
    kind: exact("kind", INDEXED_LENGTHS.taskKind).notNull(),
    status: label("status", 10).notNull(),
    abortRequested: boolean("abort_requested").notNull(),
    background: boolean("background").notNull(),
    record: json("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    ownedBy("tasks", t.scopeId),
    check("tasks_status", sql`${t.status} IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')`),
    index("tasks_by_status").on(t.scopeId, t.status, t.id),
    index("tasks_by_conversation").on(t.scopeId, t.conversationId, t.id),
    index("tasks_by_kind").on(t.scopeId, t.kind, t.id),
    index("tasks_by_abort_requested").on(t.scopeId, t.abortRequested, t.id),
    index("tasks_by_background").on(t.scopeId, t.background, t.id),
  ],
);

export const submissions = runtimeTable(
  "submissions",
  {
    scopeId: scopeIdColumn(),
    id: int8("id").notNull(),
    conversationId: int8("conversation_id").notNull(),
    requestId: exact("request_id", INDEXED_LENGTHS.requestId),
    status: label("status", 10).notNull(),
    record: json("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    ownedBy("submissions", t.scopeId),
    check("submissions_status", sql`${t.status} IN ('queued', 'placed', 'done', 'unanswered')`),
    index("submissions_by_request").on(t.scopeId, t.conversationId, t.requestId),
    index("submissions_by_conversation").on(t.scopeId, t.conversationId, t.id),
    index("submissions_by_status").on(t.scopeId, t.status, t.id),
  ],
);

/**
 * One row per document incarnation. Its address is `(kind, scope_kind, owner_id, family, key_value)`; `family` 0 is
 * a keyless document, 1 a keyed one. `created_at` / `retired_at` are commit seqs.
 */
export const documents = runtimeTable(
  "documents",
  {
    scopeId: scopeIdColumn(),
    id: int8("id").notNull(),
    kind: exact("kind", INDEXED_LENGTHS.documentKind).notNull(),
    family: smallint("family").notNull(),
    keyValue: exact("key_value", INDEXED_LENGTHS.documentKey).notNull(),
    scopeKind: label("scope_kind", 12).notNull(),
    ownerId: int8("owner_id").notNull(),
    createdAt: int8("created_at").notNull(),
    retiredAt: int8("retired_at"),
    record: json("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    ownedBy("documents", t.scopeId),
    check("documents_family", sql`${t.family} IN (0, 1)`),
    check("documents_scope_kind", sql`${t.scopeKind} IN ('session', 'conversation', 'task')`),
    index("documents_by_address").on(t.scopeId, t.kind, t.scopeKind, t.ownerId, t.family, t.keyValue, t.createdAt),
    index("documents_by_scope").on(t.scopeId, t.scopeKind, t.ownerId, t.id),
    index("documents_by_scope_kind").on(t.scopeId, t.scopeKind, t.ownerId, t.kind, t.id),
  ],
);

/** A document's revisions at commit `seq`: a `base` (its JSON value) or a `delta` (chord ops) of `version`. */
export const documentRevisions = runtimeTable(
  "document_revisions",
  {
    scopeId: scopeIdColumn(),
    documentId: int8("document_id").notNull(),
    seq: int8("seq").notNull(),
    kind: label("kind", 5).notNull(),
    version: int8("version").notNull(),
    content: json("content").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.documentId, t.seq] }),
    ownedBy("document_revisions", t.scopeId),
    check("document_revisions_kind", sql`${t.kind} IN ('base', 'delta')`),
    index("document_revisions_by_kind").on(t.scopeId, t.documentId, t.kind, t.seq),
  ],
);
