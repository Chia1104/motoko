// The single-writer lease, where it is Postgres's own: the statement that renews it, the options and the lease a
// storage takes, and the cross-connection cases (another process, a dying connection, a network partition), which need
// a real Postgres and run only with TEST_DATABASE_URL. What every shared-database store's lease does (refusal, release,
// expiry, takeover, fencing) is in the store suite (`conformance.test.ts`).

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { EntryId, Storage } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { nodeHost, processLeases } from "@chia1104/motoko-node";

import { createPostgresStore, LeaseHeldError, LeaseLostError } from "../src/index.ts";
import type { PostgresLease, PostgresStore } from "../src/index.ts";

import {
  DATABASE_URL,
  FreezableProxy,
  newPool,
  pgliteBackend,
  postgresBackend,
  Recording,
  sleep,
  statements,
  uniqueName,
  until,
} from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

const writeEntry = async (storage: Storage, kind: string) =>
  commitWrites(
    storage,
    [{ type: "entry", value: { id: (await storage.mintId()) as EntryId, conversationId: ROOT_CONVERSATION_ID, kind } }],
    context,
  );

const kindsOf = async (storage: Storage) =>
  (
    await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 100, undefined, context)
  ).items.map((entry) => entry.kind);

const reasonOf = (signal: AbortSignal) => (signal.reason as LeaseLostError).reason;

const rooted = async (store: PostgresStore, lease: PostgresLease) => {
  const storage = await store.storage(lease.scope, lease);
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
  return storage;
};

/** Acquires `scope`'s lease once the current one expires. */
async function acquireWhenFree(store: PostgresStore, scope: { kind: string; name: string }, timeoutMs = 3_000) {
  const started = Date.now();
  for (;;) {
    try {
      return await store.lease(scope);
    } catch (error) {
      if (!(error instanceof LeaseHeldError) || Date.now() - started > timeoutMs) throw error;
      await sleep(50);
    }
  }
}

describe("lease on PGlite", () => {
  let backend: Backend;
  beforeAll(async () => {
    backend = await pgliteBackend();
  });
  afterAll(async () => {
    await backend?.close();
  });

  it("renews in one statement while held", async () => {
    const scope = { kind: "agent", name: uniqueName("renew") };
    const { store, recording } = backend.recording({ ttlMs: 400, renewIntervalMs: 50 });
    const lease = await store.lease(scope);
    recording.reset();
    await sleep(600);
    // Past the TTL, still held: each renewal was confirmed by the database.
    expect(lease.signal.aborted).toBe(false);
    expect(recording.statements.length).toBeGreaterThan(3);
    for (const sql of recording.statements)
      expect(sql).toMatch(/^with "renewed" as \(update "agent_runtime"\."scopes"/);
    await lease.release();
  });

  it("validates its options and the lease a storage is opened with", async () => {
    expect(() => backend.storeWith({ ttlMs: 10 })).toThrow(RangeError);
    expect(() => backend.storeWith({ ttlMs: 1_000, renewIntervalMs: 1_000 })).toThrow(RangeError);
    expect(() => backend.storeWith({ attempts: 0 })).toThrow(RangeError);
    const scope = { kind: "agent", name: uniqueName("options") };
    const lease = await backend.store.lease(scope);
    await expect(backend.store.storage({ kind: "agent", name: "other" }, lease)).rejects.toThrow(
      "The lease is for scope",
    );
    // A lease from anywhere else (an in-process lease) fences nothing in the database. `nodeHost` takes the store
    // whole, and gives its default lease only to a storage that takes any lease, so splitting the store's pair does
    // not type-check, and is refused at the open.
    expect(nodeHost(backend.store).wake).toEqual({ kind: "process" });
    expect(nodeHost({ storage: async () => new MemoryStorage() }).wake).toEqual({ kind: "process" });
    const splits = [
      // @ts-expect-error The default lease is not the store's.
      nodeHost({ storage: backend.store.storage }),
      // @ts-expect-error Nor is `processLeases`.
      nodeHost({ lease: processLeases, storage: backend.store.storage }),
    ];
    for (const split of splits) {
      const foreign = await split.lease(scope);
      await expect(split.storage(scope, foreign)).rejects.toThrow("must come from store.lease()");
      await foreign.release();
    }
    await lease.release();
  });
});

describe.skipIf(DATABASE_URL === undefined)("lease across connections on Postgres", () => {
  let backend: Backend;
  beforeAll(async () => {
    backend = await postgresBackend(DATABASE_URL as string);
  });
  afterAll(async () => {
    await backend?.close();
  });
  const url = () => backend.url as string;

  it("refuses another process, and survives its own connections being killed", async () => {
    const scope = { kind: "agent", name: uniqueName("procs") };
    const poolA = newPool(url(), 2, "process-a");
    const poolB = newPool(url(), 2);
    try {
      const storeA = createPostgresStore(poolA, { holder: "process-a", ttlMs: 3_000, renewIntervalMs: 200 });
      const storeB = createPostgresStore(poolB, { holder: "process-b" });
      const lease = await storeA.lease(scope);
      await expect(storeB.lease(scope)).rejects.toThrow(LeaseHeldError);
      const storage = await rooted(storeA, lease);
      await writeEntry(storage, "one");

      // Kill every connection process A holds. The lease is a row, not a connection: it stays held, the pool
      // reconnects, and the storage's next commit goes through (a dead pooled connection is retried).
      const killed = await poolB.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'process-a'",
      );
      expect(killed.rowCount).toBeGreaterThan(0);
      await sleep(600);
      expect(lease.signal.aborted).toBe(false);
      await writeEntry(storage, "two");
      await expect(storeB.lease(scope)).rejects.toThrow(LeaseHeldError);
      expect(await kindsOf(storage)).toEqual(["one", "two"]);
      await lease.release();
      const leaseB = await storeB.lease(scope);
      await leaseB.release();
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  it("fences a partitioned writer's in-flight commit that reaches the server after the lease moved", async () => {
    const scope = { kind: "agent", name: uniqueName("partition") };
    const target = new URL(url());
    const proxy = new FreezableProxy(
      target.hostname === "localhost" ? "127.0.0.1" : target.hostname,
      Number(target.port || 5432),
    );
    const proxied = new URL(target);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(await proxy.port);
    const poolA = newPool(proxied.toString(), 2);
    try {
      const recording = new Recording(poolA);
      const storeA = createPostgresStore(recording.client, { ttlMs: 800, renewIntervalMs: 200 });
      const lease = await storeA.lease(scope);
      const storage = await rooted(storeA, lease);
      await writeEntry(storage, "before");

      // The partition starts between the commit's read and its write: the write statement is held in the network.
      recording.before = (sql) => {
        if (!statements.commitWrite.test(sql)) return;
        recording.before = undefined;
        proxy.freeze();
      };
      const stale = writeEntry(storage, "stale").catch((error: unknown) => error);
      await until(() => lease.signal.aborted, 3_000);
      expect(reasonOf(lease.signal)).toBe("unreachable");

      // Another process takes the scope once the lease expired, and writes.
      const next = await acquireWhenFree(backend.store, scope);
      const nextStorage = await backend.store.storage(scope, next);
      await writeEntry(nextStorage, "new-holder");

      // The partition heals: the stale write arrives, and its guard refuses it.
      proxy.thaw();
      const error = await stale;
      expect(error).toBeInstanceOf(LeaseLostError);
      // It was the write statement's guard that refused: the storage then read the scope row to explain why.
      const guard = recording.statements.findLastIndex((sql) => statements.commitWrite.test(sql));
      const diagnosis = recording.statements.findLastIndex((sql) => statements.guardDiagnosis.test(sql));
      expect(guard).toBeGreaterThan(-1);
      expect(diagnosis).toBeGreaterThan(guard);
      expect(await kindsOf(nextStorage)).toEqual(["before", "new-holder"]);
      await next.release();
    } finally {
      proxy.thaw();
      await poolA.end();
      await proxy.close();
    }
  });
});
