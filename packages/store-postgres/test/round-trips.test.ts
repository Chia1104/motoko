// Round trips outside commits, which a remote database pays for one by one: acquiring a lease, opening a storage,
// renewing many leases, and loading a document. See bench/README.md for what they cost at a given latency.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { DocumentId, StorageWrite } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { LeaseHeldError } from "../src/index.ts";
import type { PostgresLease } from "../src/index.ts";

import { backendFactories, sleep, uniqueName } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const address = {
  kind: "app.note",
  scope: { kind: "conversation" as const, conversationId: ROOT_CONVERSATION_ID },
};

for (const factory of backendFactories) {
  describe(`round trips on ${factory.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await factory.open();
    });
    afterAll(async () => {
      await backend?.close();
    });

    it("acquires a lease in one statement and opens its storage in one more, schema check included", async () => {
      const { store, recording } = backend.recording({ ttlMs: 60_000 });
      const scope = { kind: "agent", name: uniqueName("open") };
      const lease = await store.lease(scope);
      expect(recording.statements).toHaveLength(1);
      expect(recording.statements[0]).toContain("agent_runtime_drizzle");
      recording.reset();
      const storage = await store.storage(scope, lease);
      expect(recording.statements).toHaveLength(1);
      expect(await storage.mintId()).toBe(2);
      await lease.release();
      // Again on the existing row: still one statement, and a new token.
      recording.reset();
      const again = await store.lease(scope);
      expect(recording.statements).toHaveLength(1);
      expect(again.token).toBe(lease.token + 1);
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
        "SELECT count(*)::int AS n FROM agent_runtime.scopes WHERE kind = $1 AND name = $2",
        [scope.kind, scope.name],
      );
      expect(rows[0]?.n).toBe(1);
      await (won[0] as PromiseFulfilledResult<PostgresLease>).value.release();
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
        expect(sql).toMatch(/^with "renewed" as \(update "agent_runtime"\."scopes"/);
      await Promise.all(leases.map((lease) => lease.release()));
      recording.reset();
      await sleep(250);
      expect(recording.statements).toEqual([]);
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
  });
}
