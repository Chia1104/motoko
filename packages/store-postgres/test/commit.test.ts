import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { DocumentId, EntryId, StorageWrite, TaskId } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { ConcurrentCommitError, isTransientError, LeaseLostError } from "../src/index.ts";
import type { PostgresStoreOptions } from "../src/index.ts";

import { backendFactories, connectionReset, forceExpire, statements, uniqueName } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

for (const factory of backendFactories) {
  describe(`commit on ${factory.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await factory.open();
    });
    afterAll(async () => {
      await backend?.close();
    });

    async function streaming(options: PostgresStoreOptions = {}) {
      const scope = { kind: "agent", name: uniqueName("rt") };
      const { store, recording } = backend.recording(options);
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
      return { scope, storage, recording, lease, documentId, chunk };
    }

    it("stores a typical commit in two round trips, and a group of batches in the same two", async () => {
      const { storage, recording, chunk, documentId, lease } = await streaming();
      recording.reset();
      await commitWrites(storage, chunk(1), context);
      expect(recording.statements).toHaveLength(2);
      expect(recording.statements[0]).toMatch(statements.commitRead);
      expect(recording.statements[1]).toMatch(statements.commitWrite);

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
      expect(recording.statements).toHaveLength(2);
      expect(seqs).toEqual([3, 4, 5, 6]);
      expect((await storage.document(documentId, "current", context))?.value).toEqual({ text: "4" });
      await lease.release();
    });

    it("costs one more round trip per document copy (the batches before it are written, then its source read)", async () => {
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
      const kinds = recording.statements.map(
        (sql) => Object.entries(statements).find(([, pattern]) => pattern.test(sql))?.[0],
      );
      expect(kinds).toEqual(["commitRead", "commitWrite", "documentRead", "commitWrite"]);
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
        `SELECT record FROM agent_runtime.tasks t JOIN agent_runtime.scopes s USING (scope_id) WHERE s.kind = $1 AND s.name = $2`,
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

    it("retries a read whose connection failed", async () => {
      const { storage, recording, lease } = await streaming();
      let failures = 0;
      recording.before = (sql) => {
        if (sql.startsWith('select "record" from "agent_runtime"."conversations"') && failures++ === 0)
          throw connectionReset();
      };
      expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
      expect(failures).toBe(2);
      expect(isTransientError(new Error("syntax error"))).toBe(false);
      await lease.release();
    });

    it("explains a write its guard refused in one more statement", async () => {
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
      const [write, diagnosis] = recording.statements.slice(-2);
      expect(write).toMatch(statements.commitWrite);
      expect(diagnosis).toMatch(statements.guardDiagnosis);
      await lease.release();
    });
  });
}
