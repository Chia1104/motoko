// Round trips outside commits, which a remote database pays for one by one: acquiring a lease, opening a storage,
// renewing many leases, loading a document, listing unfinished scopes, erasing and deleting. Each test pins the
// statements the README's table states.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ConversationId, DocumentId, StorageWrite, TaskId } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { LeaseHeldError } from "../src/index.ts";
import type { LeaseLostError } from "../src/index.ts";
import type { MysqlLease } from "../src/index.ts";

import { backendFactories, forceExpire, sleep, statementsOf, uniqueName, until } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const address = {
  kind: "app.note",
  scope: { kind: "conversation" as const, conversationId: ROOT_CONVERSATION_ID },
};

for (const factory of backendFactories) {
  describe.skipIf(factory.skip)(`round trips on ${factory.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await factory.open();
    });
    afterAll(async () => {
      await backend?.close();
    });

    it("acquires a lease in one round trip, held or not, and opens its storage in one, schema check included", async () => {
      const { store, recording } = backend.recording({ ttlMs: 60_000 });
      const scope = { kind: "agent", name: uniqueName("open") };
      // A new scope: the upsert that creates its row with the lease, and the read that finds it taken.
      const lease = await store.lease(scope);
      expect(recording.statements).toHaveLength(1);
      expect(statementsOf(recording.statements[0])).toEqual([
        "START TRANSACTION",
        expect.stringMatching(/^INSERT INTO `agent_runtime_scopes`[^]*agent_runtime_migrations/),
        expect.stringMatching(/^SELECT \(SELECT JSON_ARRAYAGG[^]*agent_runtime_migrations/),
        "COMMIT",
      ]);
      expect(lease.token).toBe(1);
      recording.reset();
      const storage = await store.storage(scope, lease);
      expect(recording.statements).toHaveLength(1);
      expect(recording.statements[0]).toContain("agent_runtime_migrations");
      expect(await storage.mintId()).toBe(2);
      // Held: the read alone names the holder.
      recording.reset();
      await expect(backend.storeWith({ holder: "other" }).lease(scope)).rejects.toThrow(LeaseHeldError);
      await expect(store.lease(scope)).rejects.toThrow(LeaseHeldError);
      expect(recording.statements).toHaveLength(1);
      recording.reset();
      await lease.release();
      expect(recording.statements).toHaveLength(1);
      // Again on the existing row: the same round trip takes it, with a new token, on the same row.
      recording.reset();
      const again = await store.lease(scope);
      expect(recording.statements).toHaveLength(1);
      expect(again.token).toBe(lease.token + 1);
      expect(again.scopeId).toBe(lease.scopeId);
      await again.release();
    });

    it("gives a new scope's lease to exactly one of several first acquirers", async () => {
      const scope = { kind: "agent", name: uniqueName("race") };
      const stores = Array.from({ length: 5 }, (_, i) => backend.storeWith({ holder: `racer-${i}` }));
      const results = await Promise.allSettled(stores.map((store) => store.lease(scope)));
      const won = results.filter((result) => result.status === "fulfilled");
      expect(won).toHaveLength(1);
      for (const result of results.filter((result) => result.status === "rejected")) {
        expect(result.reason).toBeInstanceOf(LeaseHeldError);
      }
      const rows = await backend.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM agent_runtime_scopes WHERE kind = ? AND name = ?",
        [scope.kind, scope.name],
      );
      expect(rows[0]?.n).toBe(1);
      await (won[0] as PromiseFulfilledResult<MysqlLease>).value.release();
    });

    it("gives an expired scope's lease to exactly one of several acquirers", async () => {
      const scope = { kind: "agent", name: uniqueName("takeover") };
      const crashed = await backend.storeWith({ ttlMs: 60_000, renewIntervalMs: 59_000 }).lease(scope);
      await backend.query(
        "UPDATE agent_runtime_scopes SET lease_expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE scope_id = ?",
        [crashed.scopeId],
      );
      const stores = Array.from({ length: 5 }, (_, i) => backend.storeWith({ holder: `racer-${i}` }));
      const results = await Promise.allSettled(stores.map((store) => store.lease(scope)));
      const won = results.filter((result) => result.status === "fulfilled");
      expect(won).toHaveLength(1);
      expect((won[0] as PromiseFulfilledResult<MysqlLease>).value.token).toBe(crashed.token + 1);
      for (const result of results.filter((result) => result.status === "rejected")) {
        expect(result.reason).toBeInstanceOf(LeaseHeldError);
      }
      await (won[0] as PromiseFulfilledResult<MysqlLease>).value.release();
      crashed.lose("expired");
    });

    it("renews every lease of a store in one statement", async () => {
      const { store, recording } = backend.recording({ ttlMs: 400, renewIntervalMs: 100 });
      const leases = await Promise.all(
        Array.from({ length: 5 }, (_, i) => store.lease({ kind: "agent", name: uniqueName(`renew${i}`) })),
      );
      recording.reset();
      await sleep(650);
      // Past the TTL, all still held, with about one statement per interval for the five of them.
      for (const lease of leases) expect(lease.signal.aborted).toBe(false);
      expect(recording.statements.length).toBeGreaterThanOrEqual(3);
      expect(recording.statements.length).toBeLessThanOrEqual(8);
      for (const sql of recording.statements)
        expect(sql).toMatch(/^UPDATE `agent_runtime_scopes` SET lease_expires_at/);
      await Promise.all(leases.map((lease) => lease.release()));
      recording.reset();
      await sleep(250);
      expect(recording.statements).toEqual([]);
    });

    it("renews in two statements when a lease was not extended, which then learns why", async () => {
      const { store, recording } = backend.recording({ ttlMs: 3_000, renewIntervalMs: 100 });
      const kept = await store.lease({ kind: "agent", name: uniqueName("kept") });
      const lost = await store.lease({ kind: "agent", name: uniqueName("lost") });
      await forceExpire(backend, lost.scope);
      recording.reset();
      await until(() => lost.signal.aborted, 2_000);
      expect((lost.signal.reason as LeaseLostError).reason).toBe("expired");
      // The renewal that found it extended one lease of two, so it read the scopes' rows to learn why.
      expect(recording.statements[0]).toMatch(/^UPDATE `agent_runtime_scopes` SET lease_expires_at/);
      expect(recording.statements[1]).toMatch(
        /^SELECT scope_id, lease_token, lease_expires_at > UTC_TIMESTAMP\(3\) AS live/,
      );
      expect(kept.signal.aborted).toBe(false);
      await kept.release();
    });

    it("loads a document in one statement, and reads it again once a commit changed it", async () => {
      const { store, recording } = backend.recording();
      const scope = { kind: "agent", name: uniqueName("doc") };
      const lease = await store.lease(scope);
      const storage = await store.storage(scope, lease);
      const id = (await storage.mintId()) as DocumentId;
      // Nothing there yet; asking again before any commit costs nothing.
      recording.reset();
      expect(await storage.findDocument(address, "current", context)).toBeUndefined();
      expect(await storage.findDocument(address, "current", context)).toBeUndefined();
      expect(recording.statements).toHaveLength(1);
      const create: StorageWrite[] = [
        { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
        {
          type: "document.create",
          record: { id, ...address, history: "latest", fork: "initial" },
          content: { kind: "base", version: 1, value: { text: "a" } },
        },
      ];
      await commitWrites(storage, create, context);
      // The commit created it: found, though it was not there before.
      recording.reset();
      const record = await storage.findDocument(address, "current", context);
      expect(record?.id).toBe(id);
      expect((await storage.document(id, "current", context))?.value).toEqual({ text: "a" });
      expect(recording.statements).toHaveLength(1);
      // A commit between the find and the read: the read goes to the database and sees the change.
      await storage.findDocument(address, "current", context);
      await commitWrites(
        storage,
        [{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["text"], "b"]] } }],
        context,
      );
      recording.reset();
      expect((await storage.document(id, "current", context))?.value).toEqual({ text: "b" });
      expect(recording.statements).toHaveLength(1);
      // The prefetched content serves one read only.
      await storage.findDocument(address, "current", context);
      recording.reset();
      await storage.document(id, "current", context);
      await storage.document(id, "current", context);
      expect(recording.statements).toHaveLength(1);
      await lease.release();
    });

    it("lists unfinished scopes in one statement, after the schema check", async () => {
      const { store, recording } = backend.recording();
      await (await store.lease({ kind: "agent", name: uniqueName("left") })).release({ active: true });
      recording.reset();
      for await (const scope of store.unfinished()) expect(scope.kind).toBeTypeOf("string");
      expect(recording.statements).toHaveLength(2);
      expect(recording.statements[0]).toMatch(/agent_runtime_migrations/);
      expect(recording.statements[1]).toMatch(/^SELECT scope_id, kind, name FROM `agent_runtime_scopes`/);
    });

    it("erases a conversation in two round trips: the read, then one transaction of a statement per kind of row", async () => {
      const { store, recording } = backend.recording();
      const scope = { kind: "agent", name: uniqueName("erase") };
      const lease = await store.lease(scope);
      const storage = await store.storage(scope, lease);
      const child = (await storage.mintId()) as ConversationId;
      const doc = (await storage.mintId()) as DocumentId;
      await commitWrites(
        storage,
        [
          { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
          { type: "conversation", value: { id: child } },
          {
            type: "entry",
            value: { id: (await storage.mintId()) as never, conversationId: child, kind: "note" },
          },
          {
            type: "document.create",
            record: {
              id: doc,
              kind: "n",
              scope: { kind: "conversation", conversationId: child },
              history: "latest",
              fork: "initial",
            },
            content: { kind: "base", version: 1, value: {} },
          },
        ],
        context,
      );
      await storage.close(context);
      recording.reset();
      await store.erase(scope, lease, [child]);
      // No task: the fenced read, then the fence, documents with revisions, submissions, conversations with entries,
      // and the outcome, as one transaction.
      expect(recording.statements).toHaveLength(2);
      expect(recording.statements[0]).toMatch(/^WITH RECURSIVE owned/);
      expect(statementsOf(recording.statements[1])).toEqual([
        "START TRANSACTION",
        expect.stringMatching(/^UPDATE `agent_runtime_scopes` SET commit_nonce/),
        expect.stringMatching(/^DELETE `agent_runtime_documents`, r/),
        expect.stringMatching(/^DELETE FROM `agent_runtime_submissions`/),
        expect.stringMatching(/^DELETE `agent_runtime_conversations`, e/),
        expect.stringMatching(/^SELECT EXISTS/),
        "COMMIT",
      ]);
      const left = await backend.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM agent_runtime_conversations WHERE scope_id = ?",
        [lease.scopeId],
      );
      expect(left[0]?.n).toBe(1);
      // Nothing left to erase: the read alone.
      recording.reset();
      await store.erase(scope, lease, [child]);
      expect(recording.statements).toHaveLength(1);
      await lease.release();
    });

    it("erases nothing a commit changed after the erase read it, and reads again", async () => {
      const { store, recording } = backend.recording();
      const scope = { kind: "agent", name: uniqueName("erase-race") };
      const lease = await store.lease(scope);
      const storage = await backend.store.storage(scope, lease);
      const child = (await storage.mintId()) as ConversationId;
      await commitWrites(
        storage,
        [
          { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
          { type: "conversation", value: { id: child } },
        ],
        context,
      );
      // Between the erase's read and its delete, a commit gives the conversation a task that has work to do.
      const taskId = (await storage.mintId()) as TaskId<JsonValue>;
      recording.before = async (sql) => {
        if (!/^START TRANSACTION;\nUPDATE `agent_runtime_scopes` SET commit_nonce/.test(sql)) return;
        recording.before = undefined;
        await commitWrites(
          storage,
          [
            {
              type: "task",
              value: {
                id: taskId,
                conversationId: child,
                kind: "work",
                version: 1,
                input: null,
                state: { status: "pending", checkpoint: null },
                background: false,
                abortRequested: false,
              },
            },
          ],
          context,
        );
      };
      recording.reset();
      await store.erase(scope, lease, [child]);
      // The fence refused the stale delete; the second read found the task, so the erase skipped the conversation.
      expect(recording.statements.map((sql) => sql.slice(0, 14))).toEqual([
        "WITH RECURSIVE",
        "START TRANSACT",
        "WITH RECURSIVE",
      ]);
      expect(await storage.conversation(child, context)).toEqual({ id: child });
      expect((await storage.task(taskId, context))?.conversationId).toBe(child);
      await storage.close(context);
      await lease.release();
    });

    it("deletes a scope in one round trip after the schema check, which names a holder too", async () => {
      const { store, recording } = backend.recording();
      const scope = { kind: "agent", name: uniqueName("delete") };
      const held = await backend.storeWith({ holder: "keeper" }).lease(scope);
      recording.reset();
      const refused = await store.deleteScope(scope).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LeaseHeldError);
      expect((refused as LeaseHeldError).holder).toBe("keeper");
      expect(recording.statements).toHaveLength(2);
      await held.release();
      recording.reset();
      expect(await store.deleteScope(scope)).toBe(true);
      expect(recording.statements).toHaveLength(2);
      expect(recording.statements[0]).toMatch(/agent_runtime_migrations/);
      expect(statementsOf(recording.statements[1])).toEqual([
        "START TRANSACTION",
        expect.stringMatching(/^DELETE FROM `agent_runtime_scopes`/),
        expect.stringMatching(/^SELECT lease_holder AS holder/),
        "COMMIT",
      ]);
      expect(await store.deleteScope(scope)).toBe(false);
    });
  });
}
