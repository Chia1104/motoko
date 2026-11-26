import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { DocumentId, EntryId, StorageWrite, TaskId } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { ConcurrentCommitError, createMysqlStore, isTransientError, LeaseLostError } from "../src/index.ts";
import type { MysqlStore, MysqlStoreOptions } from "../src/index.ts";

import {
  backendFactories,
  connectionReset,
  forceExpire,
  kindOf,
  newPool,
  Recording,
  sleep,
  statements,
  uniqueName,
  writeOf,
} from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

for (const factory of backendFactories) {
  describe.skipIf(factory.skip)(`commit on ${factory.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await factory.open();
    });
    afterAll(async () => {
      await backend?.close();
    });

    async function streaming(
      options: MysqlStoreOptions = {},
      { store, recording }: { store: MysqlStore; recording: Recording } = backend.recording(options),
    ) {
      const scope = { kind: "agent", name: uniqueName("rt") };
      const lease = await backend.store.lease(scope);
      const storage = await store.storage(scope, lease);
      const taskId = (await storage.mintId()) as TaskId<JsonValue>;
      const documentId = (await storage.mintId()) as DocumentId;
      const task = (checkpoint: number) => ({
        type: "task" as const,
        value: {
          id: taskId,
          conversationId: ROOT_CONVERSATION_ID,
          kind: "pi.generation",
          version: 1,
          input: null,
          state: { status: "running" as const, checkpoint },
          background: false,
          abortRequested: false,
        },
      });
      await commitWrites(
        storage,
        [
          { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
          task(0),
          {
            type: "document.create",
            record: {
              id: documentId,
              kind: "pi.live",
              scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
              history: "latest",
              fork: "initial",
            },
            content: { kind: "base", version: 1, value: { text: "" } },
          },
        ],
        context,
      );
      const chunk = (n: number): StorageWrite[] => [
        {
          type: "document.change",
          id: documentId,
          content: { kind: "delta", version: 1, ops: [["s", ["text"], `${n}`]] },
        },
        task(n),
      ];
      return { scope, storage, recording, lease, taskId, documentId, chunk };
    }

    it("stores a streamed chunk in two round trips: the read, then a transaction of one statement per table", async () => {
      const { storage, recording, chunk, documentId, lease } = await streaming();
      recording.reset();
      await commitWrites(storage, chunk(1), context);
      expect(recording.statements.map(kindOf)).toEqual(["commitRead", "commitWrite"]);
      expect(writeOf(recording.statements[1])).toEqual([
        "guard",
        "insert tasks",
        "insert document_revisions",
        "outcome",
      ]);

      recording.reset();
      const seqs: number[] = [];
      const entryId = (await storage.mintId()) as EntryId;
      const result = await storage.commit(
        [
          chunk(2),
          chunk(3),
          [{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "pi.assistant" } }],
          chunk(4),
        ],
        (_index, seq) => seqs.push(seq),
        context,
      );
      expect(result).toEqual({ stored: 4 });
      expect(recording.statements.map(kindOf)).toEqual(["commitRead", "commitWrite"]);
      expect(writeOf(recording.statements[1])).toEqual([
        "guard",
        "insert record_ids",
        "insert entries",
        "insert tasks",
        "insert document_revisions",
        "outcome",
      ]);
      expect(seqs).toEqual([3, 4, 5, 6]);
      expect((await storage.document(documentId, "current", context))?.value).toEqual({ text: "4" });
      await lease.release();
    });

    it("clears a current-only document's revisions before writing its new base", async () => {
      const { storage, recording, documentId, lease } = await streaming();
      recording.reset();
      await commitWrites(
        storage,
        [{ type: "document.change", id: documentId, content: { kind: "base", version: 2, value: { text: "new" } } }],
        context,
      );
      expect(recording.statements.map(kindOf)).toEqual(["commitRead", "commitWrite"]);
      expect(writeOf(recording.statements[1])).toEqual([
        "guard",
        "deleteRevisions",
        "insert document_revisions",
        "outcome",
      ]);
      expect(await storage.document(documentId, "current", context)).toMatchObject({
        version: 2,
        value: { text: "new" },
      });
      const [{ n }] = (await backend.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM agent_runtime_document_revisions WHERE document_id = ? AND scope_id = ?",
        [documentId, storage.scopeId],
      )) as [{ n: number }];
      expect(n).toBe(1);
      await lease.release();
    });

    it("costs two more round trips per document copy (the batches before it are written, then its source read)", async () => {
      const { storage, recording, chunk, lease } = await streaming();
      const childId = (await storage.mintId()) as unknown as typeof ROOT_CONVERSATION_ID;
      const sourceId = (await storage.mintId()) as DocumentId;
      const copyId = (await storage.mintId()) as DocumentId;
      const record = (id: DocumentId, conversationId: typeof ROOT_CONVERSATION_ID) => ({
        id,
        kind: "copied",
        scope: { kind: "conversation" as const, conversationId },
        history: "latest" as const,
        fork: "current" as const,
      });
      recording.reset();
      const result = await storage.commit(
        [
          [
            {
              type: "document.create",
              record: record(sourceId, ROOT_CONVERSATION_ID),
              content: { kind: "base", version: 1, value: { n: 1 } },
            },
          ],
          chunk(1),
          [
            { type: "conversation", value: { id: childId } },
            { type: "document.copy", record: record(copyId, childId), source: { id: sourceId, at: "current" } },
          ],
        ],
        () => undefined,
        context,
      );
      expect(result).toEqual({ stored: 3 });
      expect(recording.statements.map(kindOf)).toEqual(["commitRead", "commitWrite", "documentRead", "commitWrite"]);
      expect(writeOf(recording.statements[1])).toEqual([
        "guard",
        "insert record_ids",
        "insert tasks",
        "insert documents",
        "insert document_revisions",
        "outcome",
      ]);
      expect(writeOf(recording.statements[3])).toEqual([
        "guard",
        "insert record_ids",
        "insert conversations",
        "insert documents",
        "insert document_revisions",
        "outcome",
      ]);
      expect((await storage.document(copyId, "current", context))?.value).toEqual({ n: 1 });
      await lease.release();
    });

    it("resolves a write whose connection failed after it took effect, and stores it once", async () => {
      const { storage, recording, chunk, documentId, lease } = await streaming();
      let failures = 0;
      recording.after = (sql) => {
        if (statements.commitWrite.test(sql) && failures++ === 0) throw connectionReset();
      };
      const seq = await commitWrites(storage, chunk(7), context);
      expect(failures).toBeGreaterThan(0);
      recording.after = undefined;
      expect((await storage.document(documentId, "current", context))?.value).toEqual({ text: "7" });
      expect(await commitWrites(storage, chunk(8), context)).toBe(seq + 1);
      await lease.release();
    });

    it("sends a write again whose connection failed before it took effect", async () => {
      const { storage, recording, chunk, documentId, lease } = await streaming();
      recording.reset();
      let failures = 0;
      recording.before = (sql) => {
        if (statements.commitWrite.test(sql) && failures++ === 0) throw connectionReset();
      };
      const seq = await commitWrites(storage, chunk(9), context);
      recording.before = undefined;
      expect(failures).toBe(2);
      expect(recording.statements.filter((sql) => statements.commitWrite.test(sql))).toHaveLength(2);
      expect((await storage.document(documentId, "current", context))?.value).toEqual({ text: "9" });
      expect(await commitWrites(storage, chunk(10), context)).toBe(seq + 1);
      await lease.release();
    });

    it("never counts an unknown outcome as stored once another holder took the lease, even at the same seq", async () => {
      const { scope, storage, recording, chunk } = await streaming();
      recording.before = async (sql) => {
        if (!statements.commitWrite.test(sql)) return;
        recording.before = undefined;
        await forceExpire(backend, scope);
        const next = await backend.store.lease(scope);
        const nextStorage = await backend.store.storage(scope, next);
        await commitWrites(
          nextStorage,
          [
            {
              type: "entry",
              value: {
                id: (await nextStorage.mintId()) as EntryId,
                conversationId: ROOT_CONVERSATION_ID,
                kind: "next",
              },
            },
          ],
          context,
        );
        throw connectionReset();
      };
      const error = await commitWrites(storage, chunk(11), context).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LeaseLostError);
      expect((error as LeaseLostError).reason).toBe("taken");
      expect(isTransientError((error as LeaseLostError).cause)).toBe(true);
      const rows = await backend.query<{ record: string }>(
        `SELECT t.record FROM agent_runtime_tasks t JOIN agent_runtime_scopes s USING (scope_id) WHERE s.kind = ? AND s.name = ?`,
        [scope.kind, scope.name],
      );
      expect(rows.map((row) => JSON.parse(row.record).state.checkpoint)).toEqual([0]);
    });

    it("rejects with the connection error once its attempts are used up", async () => {
      const { storage, recording, chunk, lease } = await streaming({ attempts: 1 });
      recording.after = (sql) => {
        if (statements.commitWrite.test(sql)) throw connectionReset();
      };
      const error = await commitWrites(storage, chunk(1), context).catch((caught: unknown) => caught);
      expect(isTransientError(error)).toBe(true);
      expect(error).toMatchObject({ cause: { code: "ECONNRESET" } });
      await lease.release();
    });

    async function streamingOnOneConnection() {
      const pool = newPool(backend.url, 1);
      const recording = new Recording(pool);
      const streamed = await streaming({}, { store: createMysqlStore(recording.client), recording });
      return { ...streamed, end: () => pool.end() };
    }

    it("leaves nothing of a write that failed part way, and runs no later query inside its transaction", async () => {
      const { storage, chunk, taskId, documentId, lease, end } = await streamingOnOneConnection();
      try {
        const seq = await commitWrites(storage, chunk(1), context);
        await backend.query(
          `INSERT INTO agent_runtime_document_revisions (scope_id, document_id, seq, kind, version, content)
            VALUES (?, ?, ?, 'delta', 1, '[]')`,
          [storage.scopeId, documentId, seq + 1],
        );
        const error = await commitWrites(storage, chunk(2), context).catch((caught: unknown) => caught);
        expect(isTransientError(error)).toBe(false);
        expect(error).toMatchObject({ cause: { code: "ER_DUP_ENTRY" } });
        const entry = (await storage.mintId()) as EntryId;
        const next = await commitWrites(
          storage,
          [{ type: "entry", value: { id: entry, conversationId: ROOT_CONVERSATION_ID, kind: "after" } }],
          context,
        );
        expect(next).toBe(seq + 1);
        expect((await storage.task(taskId, context))?.state).toEqual({ status: "running", checkpoint: 1 });
      } finally {
        // End the pool first. A connection left inside a transaction would keep the scope's row locked against the
        // release.
        await end();
        await lease.release();
      }
    });

    it("resolves a write a transient failure stopped part way as an unknown outcome, and stores it once", async () => {
      const { storage, recording, chunk, taskId, documentId, lease, end } = await streamingOnOneConnection();
      const blocker = await mysql.createConnection({ uri: backend.url });
      try {
        await blocker.query("START TRANSACTION");
        await blocker.query("SELECT id FROM agent_runtime_tasks WHERE scope_id = ? AND id = ? FOR UPDATE", [
          storage.scopeId,
          taskId,
        ]);
        recording.reset();
        const write = commitWrites(storage, chunk(5), context);
        let waiting: number | undefined;
        while (waiting === undefined) {
          await sleep(10);
          const [rows] = await blocker.query(
            `SELECT t.trx_mysql_thread_id AS id FROM information_schema.innodb_trx AS t
              JOIN performance_schema.threads AS th ON th.PROCESSLIST_ID = t.trx_mysql_thread_id
              WHERE t.trx_state = 'LOCK WAIT' AND th.PROCESSLIST_DB = DATABASE()`,
          );
          waiting = (rows as { id: number }[])[0]?.id;
        }
        // Interrupted mid-wait, the INSERT fails with ER_QUERY_INTERRUPTED, a transient error, and leaves the
        // transaction open with its guard applied.
        await blocker.query(`KILL QUERY ${Number(waiting)}`);
        await blocker.query("ROLLBACK");
        const seq = await write;
        expect(recording.statements.map(kindOf)).toEqual(["commitRead", "commitWrite", "commitRead", "commitWrite"]);
        expect((await storage.task(taskId, context))?.state).toEqual({ status: "running", checkpoint: 5 });
        expect((await storage.document(documentId, "current", context))?.value).toEqual({ text: "5" });
        expect(await commitWrites(storage, chunk(6), context)).toBe(seq + 1);
      } finally {
        await end();
        await blocker.end();
        await lease.release();
      }
    });

    it("retries a read whose connection failed", async () => {
      const { storage, recording, lease } = await streaming();
      let failures = 0;
      recording.before = (sql) => {
        if (sql.startsWith("select `record` from `agent_runtime_conversations`") && failures++ === 0)
          throw connectionReset();
      };
      expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
      expect(failures).toBe(2);
      expect(isTransientError(new Error("syntax error"))).toBe(false);
      await lease.release();
    });

    it("explains a write its guard refused in the same round trip, and writes nothing", async () => {
      const scope = { kind: "agent", name: uniqueName("two-writers") };
      const lease = await backend.store.lease(scope);
      const first = await backend.store.storage(scope, lease);
      await commitWrites(first, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
      const { store, recording } = backend.recording();
      const second = await store.storage(scope, lease);
      recording.before = async (sql) => {
        if (!statements.commitWrite.test(sql)) return;
        recording.before = undefined;
        await commitWrites(
          first,
          [
            {
              type: "entry",
              value: { id: (await first.mintId()) as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: "first" },
            },
          ],
          context,
        );
      };
      await expect(
        commitWrites(
          second,
          [{ type: "entry", value: { id: 1000 as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: "second" } }],
          context,
        ),
      ).rejects.toThrow(ConcurrentCommitError);
      expect(recording.statements.slice(1).map(kindOf)).toEqual(["commitRead", "commitWrite"]);
      const kinds = await first.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context);
      expect(kinds.items.map((entry) => entry.kind)).toEqual(["first"]);
      await lease.release();
    });

    it("rejects an indexed string longer than its index before it writes anything", async () => {
      const { storage, recording, lease } = await streaming();
      recording.reset();
      const id = (await storage.mintId()) as TaskId<JsonValue>;
      const task = {
        type: "task" as const,
        value: {
          id,
          conversationId: ROOT_CONVERSATION_ID,
          kind: "k".repeat(800),
          version: 1,
          input: null,
          state: { status: "pending" as const, checkpoint: null },
          background: false,
          abortRequested: false,
        },
      };
      await expect(commitWrites(storage, [task], context)).rejects.toThrow("too long for MySQL's index");
      expect(recording.statements.map(kindOf)).toEqual(["commitRead"]);
      expect(await storage.task(id, context)).toBeUndefined();
      await commitWrites(storage, [{ ...task, value: { ...task.value, kind: "k".repeat(758) } }], context);
      expect((await storage.task(id, context))?.kind).toBe("k".repeat(758));
      await lease.release();
    });
  });
}
