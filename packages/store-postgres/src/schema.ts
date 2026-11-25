/**
 * An app may import this module, `@chia1104/motoko-store-postgres/schema`, to read the runtime's tables with its own
 * Drizzle instance. Motoko writes them. An app that writes them bypasses the storage's checks and its lease.
 *
 * Records are JSON in `text` columns, not `jsonb`, because jsonb rejects `\u0000` and lone-surrogate escapes, which
 * pi-durable stores. Indexed strings hold the JSON encoding of the string, so lone surrogates survive. Their columns
 * are `COLLATE "C"`, which orders and compares by bytes, as pi-durable's SQLite storage does.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** The Postgres schema the runtime's tables live in. */
export const runtimeSchema = pgSchema("agent_runtime");

const textC = customType<{ data: string; driverData: string }>({
  dataType: () => 'text COLLATE "C"',
});

const int8 = (name: string) => bigint(name, { mode: "number" });

const scopeId = () =>
  int8("scope_id")
    .notNull()
    .references(() => scopes.scopeId, { onDelete: "cascade" });

/**
 * One row per scope. `next_id` and `next_seq` are the scope's ID and commit-sequence counters. `lease_*` is its
 * single-writer lease, made of a holder label, an expiry by the database clock, and a fencing token that increases with
 * every acquisition. `wake_*` is what the scope's last holder left as it released the lease. It is pi-durable's `Wake`,
 * the work that can run and the earliest sleep, in epoch ms on the Harness clock. A scope whose `wake_*` holds work, or
 * whose holder never released the lease, is one that `unfinished()` lists.
 */
export const scopes = runtimeSchema.table(
  "scopes",
  {
    scopeId: int8("scope_id").primaryKey().generatedAlwaysAsIdentity(),
    kind: textC("kind").notNull(),
    name: textC("name").notNull(),
    nextId: int8("next_id").notNull().default(2),
    nextSeq: int8("next_seq").notNull().default(1),
    leaseToken: int8("lease_token").notNull().default(0),
    leaseHolder: text("lease_holder"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    wakeActive: boolean("wake_active").notNull().default(false),
    wakeAt: int8("wake_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("scopes_kind_name").on(t.kind, t.name),
    index("scopes_unfinished")
      .on(t.scopeId)
      .where(sql`${t.wakeActive} OR ${t.wakeAt} IS NOT NULL OR ${t.leaseHolder} IS NOT NULL`),
  ],
);

/** Every claimed record ID of a scope and the table that claimed it. */
export const recordIds = runtimeSchema.table(
  "record_ids",
  {
    scopeId: scopeId(),
    id: int8("id").notNull(),
    recordType: text("record_type").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    check(
      "record_ids_record_type",
      sql`${t.recordType} IN ('conversation', 'entry', 'task', 'submission', 'document')`,
    ),
  ],
);

export const conversations = runtimeSchema.table(
  "conversations",
  {
    scopeId: scopeId(),
    id: int8("id").notNull(),
    ownerConversationId: int8("owner_conversation_id"),
    ownerTaskId: int8("owner_task_id"),
    parentConversationId: int8("parent_conversation_id"),
    parentAt: int8("parent_at"),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    index("conversations_by_owner_conversation").on(t.scopeId, t.ownerConversationId, t.id),
    index("conversations_by_owner_task").on(t.scopeId, t.ownerTaskId, t.id),
  ],
);

export const entries = runtimeSchema.table(
  "entries",
  {
    scopeId: scopeId(),
    id: int8("id").notNull(),
    conversationId: int8("conversation_id").notNull(),
    head: int8("head"),
    commitSeq: int8("commit_seq").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    index("entries_by_conversation").on(t.scopeId, t.conversationId, t.id),
    index("entry_heads_by_conversation")
      .on(t.scopeId, t.conversationId, t.id)
      .where(sql`${t.head} IS NOT NULL`),
  ],
);

export const tasks = runtimeSchema.table(
  "tasks",
  {
    scopeId: scopeId(),
    id: int8("id").notNull(),
    conversationId: int8("conversation_id").notNull(),
    kind: textC("kind").notNull(),
    status: text("status").notNull(),
    abortRequested: boolean("abort_requested").notNull(),
    background: boolean("background").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    check("tasks_status", sql`${t.status} IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')`),
    index("tasks_by_status").on(t.scopeId, t.status, t.id),
    index("tasks_by_conversation").on(t.scopeId, t.conversationId, t.id),
    index("tasks_by_kind").on(t.scopeId, t.kind, t.id),
    index("tasks_by_abort_requested").on(t.scopeId, t.abortRequested, t.id),
    index("tasks_by_background").on(t.scopeId, t.background, t.id),
  ],
);

export const submissions = runtimeSchema.table(
  "submissions",
  {
    scopeId: scopeId(),
    id: int8("id").notNull(),
    conversationId: int8("conversation_id").notNull(),
    requestId: textC("request_id"),
    status: text("status").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    check("submissions_status", sql`${t.status} IN ('queued', 'placed', 'done', 'unanswered')`),
    index("submissions_by_request").on(t.scopeId, t.conversationId, t.requestId),
    index("submissions_by_conversation").on(t.scopeId, t.conversationId, t.id),
    index("submissions_by_status").on(t.scopeId, t.status, t.id),
  ],
);

/**
 * One row per document incarnation. Its address is `(kind, scope_kind, owner_id, family, key_value)`. `family` is 0 for
 * a keyless document and 1 for a keyed one. `created_at` and `retired_at` are commit seqs.
 */
export const documents = runtimeSchema.table(
  "documents",
  {
    scopeId: scopeId(),
    id: int8("id").notNull(),
    kind: textC("kind").notNull(),
    family: smallint("family").notNull(),
    keyValue: textC("key_value").notNull(),
    scopeKind: text("scope_kind").notNull(),
    ownerId: int8("owner_id").notNull(),
    createdAt: int8("created_at").notNull(),
    retiredAt: int8("retired_at"),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.id] }),
    check("documents_family", sql`${t.family} IN (0, 1)`),
    check("documents_scope_kind", sql`${t.scopeKind} IN ('session', 'conversation', 'task')`),
    index("documents_by_address").on(
      t.scopeId,
      t.kind,
      t.scopeKind,
      t.ownerId,
      t.family,
      t.keyValue,
      t.createdAt.desc().nullsFirst(),
    ),
    index("documents_by_scope").on(t.scopeId, t.scopeKind, t.ownerId, t.id),
    index("documents_by_scope_kind").on(t.scopeId, t.scopeKind, t.ownerId, t.kind, t.id),
  ],
);

/**
 * A document's revisions at commit `seq`. Each revision of `version` is a `base`, which holds the JSON value, or a
 * `delta`, which holds chord ops.
 */
export const documentRevisions = runtimeSchema.table(
  "document_revisions",
  {
    scopeId: scopeId(),
    documentId: int8("document_id").notNull(),
    seq: int8("seq").notNull(),
    kind: text("kind").notNull(),
    version: int8("version").notNull(),
    content: text("content").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scopeId, t.documentId, t.seq] }),
    check("document_revisions_kind", sql`${t.kind} IN ('base', 'delta')`),
    index("document_revisions_by_kind").on(t.scopeId, t.documentId, t.kind, t.seq.desc().nullsFirst()),
  ],
);
