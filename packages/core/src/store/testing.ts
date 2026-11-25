import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  DocumentId,
  EntryId,
  Seq,
  Storage,
  StorageWrite,
  SubmissionId,
  TaskId,
} from "@earendil-works/pi-durable";
import { commitWrites, createExpectAssertions } from "@earendil-works/pi-durable/testing";
import type { StorageConformanceRunner } from "@earendil-works/pi-durable/testing";
import * as z from "zod";

import { defineAgent } from "../agent.ts";
import { LeaseHeldError as RuntimeLeaseHeldError } from "../errors.ts";
import type { AgentHost, StorageScope } from "../host.ts";
import { createAgentRuntime } from "../runtime.ts";
import type { InstanceReport } from "../runtime.ts";
import { defineTool } from "../tool.ts";

import { ConcurrentCommitError, LeaseHeldError, LeaseLostError, ScopeDeletedError } from "./errors.ts";
import type { LeaseLossReason } from "./errors.ts";
import type { FencedLease } from "./lease.ts";
import type { SharedStore, SharedStoreOptions } from "./store.ts";

/** A store over the same database whose statements a case controls. */
export interface ControlledStore<S extends Storage = Storage> {
  readonly store: SharedStore<S>;
  /** Runs `hook` once, after the store's next commit read its check state and before it sends its write. */
  beforeWrite(hook: () => Promise<void>): void;
  /** Fails every statement of the store from now on, as a connection that died. */
  sever(): void;
}

/** Another process on the same database, which is a store over a connection of its own. */
export interface StoreProcess<S extends Storage = Storage> {
  readonly store: SharedStore<S>;
  /** The process dies. Its connection closes, and nothing it holds is released. */
  exit(): Promise<void>;
}

/** What the store suite needs from a dialect's tests: the store, and what only the dialect can do to its database. */
export interface StoreConformanceTarget<S extends Storage = Storage> {
  /** The store under test. Every case uses scopes of its own, so one database may serve them all. */
  readonly store: SharedStore<S>;
  /** Another store over the same database, with its own options. */
  storeWith(options: SharedStoreOptions): SharedStore<S>;
  /** A store over the same database whose statements the case controls. */
  controlled(options?: SharedStoreOptions): ControlledStore<S>;
  /** Makes `scope`'s lease expire now by the database clock, as if its holder had stalled past its TTL. */
  expire(scope: StorageScope): Promise<void>;
  /** Deletes `scope`'s row from outside the store, telling none of its holders. */
  remove(scope: StorageScope): Promise<void>;
  /** What `scope`'s row recorded at its last release: work that can run, and its earliest sleep. */
  wake(scope: StorageScope): Promise<{ readonly active: boolean; readonly at: number | undefined } | undefined>;
  /** The rows the scope `storage` was opened on owns, one count per table, the scope's own row included. */
  rows(storage: S): Promise<readonly number[]>;
  /**
   * Optional. Another process on the same database. A store whose database has one connection, such as an in-process
   * database, leaves it out, and the cases that need it pass without running.
   */
  otherProcess?(options: SharedStoreOptions): Promise<StoreProcess<S>>;
}

/** Calls `use` once with a target, then cleans up whatever the target holds. */
export type StoreConformanceProvider<S extends Storage = Storage> = (
  use: (target: StoreConformanceTarget<S>) => Promise<void>,
) => Promise<void>;

const context = BACKGROUND_CONTEXT;

const freshScope = (label: string): StorageScope => ({
  kind: "store-conformance",
  name: `${label}-${crypto.randomUUID()}`,
});

async function failureOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await sleep(10);
  }
}

const reasonOf = (signal: AbortSignal): LeaseLossReason | undefined =>
  signal.reason instanceof LeaseLostError ? signal.reason.reason : undefined;

const root: StorageWrite = { type: "conversation", value: { id: ROOT_CONVERSATION_ID } };

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

async function rooted<S extends Storage>(store: SharedStore<S>, lease: FencedLease): Promise<S> {
  const storage = await store.storage(lease.scope, lease);
  await commitWrites(storage, [root], context);
  return storage;
}

async function acquireWhenFree(store: SharedStore, scope: StorageScope, timeoutMs = 3_000): Promise<FencedLease> {
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

async function listed(store: SharedStore): Promise<StorageScope[]> {
  const scopes: StorageScope[] = [];
  for await (const scope of store.unfinished()) scopes.push(scope);
  return scopes;
}

const has = (scopes: readonly StorageScope[], scope: StorageScope) =>
  scopes.some((listedScope) => listedScope.kind === scope.kind && listedScope.name === scope.name);

interface Ids {
  child: ConversationId;
  first: EntryId;
  marker: EntryId;
  forked: EntryId;
  task: TaskId<JsonValue>;
  submission: SubmissionId;
  sessionDoc: DocumentId;
  rewindable: DocumentId;
}

async function seed(storage: Storage, tag: string): Promise<{ ids: Ids; seqs: Seq[] }> {
  const mint = <I>() => storage.mintId() as Promise<I>;
  const seqs: Seq[] = [];
  seqs.push(await commitWrites(storage, [root], context));
  const ids: Ids = {
    first: await mint(),
    marker: await mint(),
    child: await mint(),
    forked: await mint(),
    task: await mint(),
    submission: await mint(),
    sessionDoc: await mint(),
    rewindable: await mint(),
  };
  const writes: StorageWrite[] = [
    { type: "entry", value: { id: ids.first, conversationId: ROOT_CONVERSATION_ID, kind: "note", data: { tag } } },
    {
      type: "entry",
      value: { id: ids.marker, conversationId: ROOT_CONVERSATION_ID, kind: "reset", head: ids.marker, data: { tag } },
    },
    {
      type: "task",
      value: {
        id: ids.task,
        conversationId: ROOT_CONVERSATION_ID,
        kind: "shared.kind",
        version: 1,
        input: { tag },
        state: { status: "pending", checkpoint: { tag } },
        background: false,
        abortRequested: false,
      },
    },
    {
      type: "submission",
      value: {
        id: ids.submission,
        conversationId: ROOT_CONVERSATION_ID,
        requestId: "same-request",
        type: "input",
        status: "queued",
      },
    },
    {
      type: "document.create",
      record: { id: ids.sessionDoc, kind: "shared.doc", scope: { kind: "session" } },
      content: { kind: "base", version: 1, value: { tag } },
    },
    {
      type: "document.create",
      record: {
        id: ids.rewindable,
        kind: "shared.rewindable",
        scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
        history: "rewindable",
        fork: "asOf",
      },
      content: { kind: "base", version: 1, value: { tag, n: 1 } },
    },
  ];
  seqs.push(await commitWrites(storage, writes, context));
  seqs.push(
    await commitWrites(
      storage,
      [{ type: "document.change", id: ids.rewindable, content: { kind: "delta", version: 1, ops: [["s", ["n"], 2]] } }],
      context,
    ),
  );
  seqs.push(
    await commitWrites(
      storage,
      [
        {
          type: "conversation",
          value: { id: ids.child, parent: { conversationId: ROOT_CONVERSATION_ID, at: ids.marker } },
        },
        { type: "entry", value: { id: ids.forked, conversationId: ids.child, kind: "note", data: { tag } } },
      ],
      context,
    ),
  );
  return { ids, seqs };
}

async function everything(storage: Storage, ids: Ids, seqs: Seq[]) {
  const limit = 100;
  return {
    conversation: await storage.conversation(ROOT_CONVERSATION_ID, context),
    child: await storage.conversation(ids.child, context),
    conversations: await storage.scanConversations({}, limit, undefined, context),
    conversationsDescending: await storage.scanConversations({ order: "descending" }, limit, undefined, context),
    entry: await storage.entry(ids.first, context),
    visibleEntry: await storage.entry(ids.child, ids.first, context),
    marker: await storage.findLatestHeadMarker(ids.child, undefined, context),
    entries: await storage.scanEntries({ conversationId: ids.child }, limit, undefined, context),
    entriesAscending: await storage.scanEntries(
      { conversationId: ids.child, order: "ascending" },
      limit,
      undefined,
      context,
    ),
    task: await storage.task(ids.task, context),
    tasks: await storage.scanTasks({ kind: "shared.kind" }, limit, undefined, context),
    submission: await storage.submission(ids.submission, context),
    submissions: await storage.scanSubmissions({}, limit, undefined, context),
    byRequest: await storage.submissionByRequest(ROOT_CONVERSATION_ID, "same-request", context),
    found: await storage.findDocument({ kind: "shared.doc", scope: { kind: "session" } }, "current", context),
    document: await storage.document(ids.sessionDoc, "current", context),
    rewindableNow: await storage.document(ids.rewindable, "current", context),
    rewindableThen: await storage.document(ids.rewindable, seqs[1] as Seq, context),
    sessionDocuments: await storage.scanDocuments(
      { scope: { kind: "session" }, at: "current" },
      limit,
      undefined,
      context,
    ),
    rootDocuments: await storage.scanDocuments(
      { scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID }, at: "current" },
      limit,
      undefined,
      context,
    ),
  };
}

function tags(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) tags(item, found);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "tag" && typeof item === "string") found.add(item);
      else tags(item, found);
    }
  }
  return found;
}

const remove = defineTool({
  name: "remove",
  description: "Delete a note",
  tier: "write",
  parameters: z.object({}),
  async execute() {
    return { text: "deleted" };
  },
});

const agent = defineAgent({
  kind: "store-conformance",
  instructions: "You work.",
  tools: [remove],
  policy: { requiresApproval: ["write"] },
});

function runtimeOn(store: SharedStore, reports: InstanceReport[] = []) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const host: AgentHost = { ...store, wake: { kind: "process" } };
  const runtime = createAgentRuntime({
    agents: [agent],
    host,
    models,
    ports: {},
    defaultModel: { provider: faux.provider.id, modelId: faux.getModel().id },
    onReport: (report) => reports.push(report),
  });
  return { runtime, faux };
}

/**
 * Registers the guarantees of a shared-database store, a `SharedStore`, under `name`. A writer that lost its lease
 * writes nothing. A lease expires and is taken over. Release records the wake that `unfinished()` lists. Scopes in one
 * database are kept apart. The cases also cover the rules of `erase` and `deleteScope`. Round trips, schema and a
 * dialect's own connection behaviour stay in its own tests.
 */
export function registerStoreConformance<S extends Storage>(
  runner: StorageConformanceRunner,
  name: string,
  provider: StoreConformanceProvider<S>,
): void {
  const assert = createExpectAssertions(runner.expect);
  const assertHeld = (error: unknown) =>
    assert.ok(error instanceof LeaseHeldError, `Expected a LeaseHeldError, got ${String(error)}`);
  const assertLost = (error: unknown, reason?: LeaseLossReason) =>
    assert.ok(
      error instanceof LeaseLostError && (reason === undefined || error.reason === reason),
      `Expected a LeaseLostError${reason === undefined ? "" : ` (${reason})`}, got ${String(error)}`,
    );

  const open = async (target: StoreConformanceTarget<S>, scope: StorageScope) => {
    const lease = await target.store.lease(scope);
    return { lease, storage: await target.store.storage(scope, lease) };
  };

  const cases: Record<string, (target: StoreConformanceTarget<S>) => Promise<void>> = {
    async "refuses a second holder with a LeaseHeldError naming the first, until the first releases"(target) {
      const scope = freshScope("lease");
      const first = await target.storeWith({ holder: "worker-1" }).lease(scope);
      const refused = await failureOf(() => target.storeWith({ holder: "worker-2" }).lease(scope));
      assertHeld(refused);
      assert.ok(refused instanceof RuntimeLeaseHeldError, "Expected the runtime's LeaseHeldError");
      const held = refused as LeaseHeldError;
      assert.strictEqual(held.holder, "worker-1");
      assert.ok(held.expiresAt instanceof Date, "Expected the lease's expiry");
      assert.deepEqual(held.scope, scope);
      assert.strictEqual(first.signal.aborted, false);
      await first.release();
      assert.strictEqual(reasonOf(first.signal), "released");
      const second = await target.store.lease(scope);
      assert.strictEqual(second.token, first.token + 1);
      assertLost(await failureOf(() => target.store.storage(scope, first)));
      await second.release();
      await second.release();
    },

    async "frees the scope by itself once a holder stops renewing"(target) {
      const scope = freshScope("crash");
      const crashing = target.controlled({ ttlMs: 400, renewIntervalMs: 100 });
      const crashed = await crashing.store.lease(scope);
      crashing.sever();
      assertHeld(await failureOf(() => target.store.lease(scope)));
      await until(() => crashed.signal.aborted, 2_000);
      assert.strictEqual(reasonOf(crashed.signal), "unreachable");
      await sleep(50);
      const next = await target.store.lease(scope);
      assert.greaterThan(next.token, crashed.token);
      await next.release();
    },

    async "frees the scope after its holder's process dies without releasing"(target) {
      if (target.otherProcess === undefined) return;
      const scope = freshScope("died");
      const other = await target.otherProcess({ ttlMs: 800, renewIntervalMs: 200 });
      const lease = await other.store.lease(scope);
      await other.exit();
      assertHeld(await failureOf(() => target.store.lease(scope)));
      await until(() => lease.signal.aborted, 3_000);
      assert.strictEqual(reasonOf(lease.signal), "unreachable");
      const next = await acquireWhenFree(target.store, scope);
      assert.strictEqual(next.token, lease.token + 1);
      await next.release();
    },

    async "detects a lease taken over after it expired, and fences the old holder's commits"(target) {
      const scope = freshScope("taken");
      const old = await target.storeWith({ ttlMs: 2_000, renewIntervalMs: 50 }).lease(scope);
      const oldStorage = await rooted(target.store, old);
      await writeEntry(oldStorage, "before");
      await target.expire(scope);
      const next = await target.store.lease(scope);
      await until(() => old.signal.aborted, 2_000);
      assert.strictEqual(reasonOf(old.signal), "taken");
      assertLost(await failureOf(() => writeEntry(oldStorage, "stale")));
      const nextStorage = await target.store.storage(scope, next);
      assert.deepEqual(await kindsOf(nextStorage), ["before"]);
      await writeEntry(nextStorage, "after");
      assert.deepEqual(await kindsOf(nextStorage), ["before", "after"]);
      await next.release();
    },

    async "fences a stale writer in the database even before it notices the loss"(target) {
      const scope = freshScope("fence");
      const rarely = target.storeWith({ ttlMs: 60_000, renewIntervalMs: 59_000 });
      const old = await rarely.lease(scope);
      const controlled = target.controlled();
      const oldStorage = await rooted(controlled.store, old);

      let next: FencedLease | undefined;
      controlled.beforeWrite(async () => {
        await target.expire(scope);
        next = await target.store.lease(scope);
      });
      assert.strictEqual(old.signal.aborted, false);
      assertLost(await failureOf(() => writeEntry(oldStorage, "stale")), "taken");
      assert.strictEqual(old.signal.aborted, true);
      if (next === undefined) throw new Error("the lease did not change hands");
      const nextStorage = await target.store.storage(scope, next);
      assert.deepEqual(await kindsOf(nextStorage), []);

      const olderScope = freshScope("fence-read");
      const older = await rarely.lease(olderScope);
      const olderStorage = await rooted(target.store, older);
      await target.expire(olderScope);
      const newer = await target.store.lease(olderScope);
      assertLost(await failureOf(() => writeEntry(olderStorage, "stale")));
      await newer.release();
      await next.release();
    },

    async "refuses commits once the lease has expired, even when nobody took it"(target) {
      const scope = freshScope("expired");
      const lease = await target.storeWith({ ttlMs: 60_000, renewIntervalMs: 59_000 }).lease(scope);
      const storage = await rooted(target.store, lease);
      await target.expire(scope);
      assertLost(await failureOf(() => writeEntry(storage, "late")), "expired");
      const next = await target.store.lease(scope);
      assert.deepEqual(await kindsOf(await target.store.storage(scope, next)), []);
      await next.release();
    },

    async "refuses to write after another storage under the same lease committed to the scope"(target) {
      const scope = freshScope("two-writers");
      const lease = await target.store.lease(scope);
      const first = await target.store.storage(scope, lease);
      await commitWrites(first, [root], context);
      const controlled = target.controlled();
      const second = await controlled.store.storage(scope, lease);
      controlled.beforeWrite(async () => {
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
      });
      const error = await failureOf(() =>
        commitWrites(
          second,
          [{ type: "entry", value: { id: 1000 as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: "second" } }],
          context,
        ),
      );
      assert.ok(error instanceof ConcurrentCommitError, `Expected a ConcurrentCommitError, got ${String(error)}`);
      const kinds = (
        await first.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context)
      ).items.map((entry) => entry.kind);
      assert.deepEqual(kinds, ["first"]);
      assert.strictEqual(lease.signal.aborted, false);
      await lease.release();
    },

    async "records what each release leaves, and lists only the scopes left with work or a sleep"(target) {
      const [running, sleeping, done, held] = ["running", "sleeping", "done", "held"].map((label) =>
        freshScope(label),
      ) as [StorageScope, StorageScope, StorageScope, StorageScope];
      for (const [scope, wake] of [
        [running, { active: true }],
        [sleeping, { active: false, at: Date.now() + 60_000 }],
        [done, { active: false }],
      ] as const) {
        await (await target.store.lease(scope)).release(wake);
      }
      const holder = await target.store.lease(held);
      const recorded = await target.wake(sleeping);
      assert.strictEqual(recorded?.active, false);
      assert.greaterThan(recorded?.at ?? 0, Date.now());

      const scopes = await listed(target.store);
      assert.deepEqual([has(scopes, running), has(scopes, sleeping)], [true, true]);
      assert.deepEqual([has(scopes, done), has(scopes, held)], [false, false]);
      await holder.release({ active: false });
    },

    async "lists a scope whose holder never released it, once its lease expires"(target) {
      const scope = freshScope("crashed");
      const crashed = await target.store.lease(scope);
      assert.strictEqual(has(await listed(target.store), scope), false);
      await target.expire(scope);
      assert.strictEqual(has(await listed(target.store), scope), true);
      crashed.lose("expired");
    },

    async "erases a deleted session's rows once the instance closes, and keeps the others"(target) {
      const reports: InstanceReport[] = [];
      const { runtime, faux } = runtimeOn(target.store, reports);
      const name = crypto.randomUUID();
      const instance = runtime.get(agent, name);
      const kept = await instance.createSession();
      const doomed = await instance.createSession();
      faux.setResponses([fauxAssistantMessage("Kept."), fauxAssistantMessage("Secret.")]);
      await instance.session(kept.id).submit({ text: "Kept question", requestId: "1" });
      await until(() => faux.state.callCount === 1);
      await instance.session(doomed.id).submit({ text: "Secret question", requestId: "2" });
      await until(() => faux.state.callCount === 2);
      await until(() => runtime.inspect().instances.every((held) => held.operations === 0));

      await instance.session(doomed.id).delete();
      await instance.close();
      assert.deepEqual(reports, []);
      assert.deepEqual(await runtime.get(agent, name).listSessions(), [kept]);
      await runtime.close();

      const scope = { kind: agent.kind, name };
      const { lease, storage } = await open(target, scope);
      try {
        const conversationId = Number(doomed.id) as ConversationId;
        assert.strictEqual(await storage.conversation(conversationId, context), undefined);
        assert.deepEqual((await storage.scanTasks({ conversationId }, 100, undefined, context)).items, []);
        assert.deepEqual((await storage.scanSubmissions({ conversationId }, 100, undefined, context)).items, []);
        const unminted = Number(await storage.mintId());
        for (let id = 1; id < unminted; id++) {
          const found = await storage.entry(id as EntryId, context);
          assert.ok(
            found?.entry.conversationId !== conversationId,
            `Entry ${id} of the erased session is still stored`,
          );
        }
        assert.ok(
          (await storage.conversation(Number(kept.id) as ConversationId, context)) !== undefined,
          "Expected the kept session",
        );
      } finally {
        await storage.close(context);
        await lease.release();
      }
    },

    async "leaves a conversation that still has unfinished work, and erases nothing without the lease"(target) {
      const { runtime, faux } = runtimeOn(target.store);
      const name = crypto.randomUUID();
      const instance = runtime.get(agent, name);
      const { id } = await instance.createSession();
      faux.setResponses([fauxAssistantMessage(fauxToolCall("remove", {}, { id: "rm-1" }), { stopReason: "toolUse" })]);
      await instance.session(id).submit({ text: "Delete", requestId: "1" });
      await until(() => faux.state.callCount === 1);
      await runtime.close();

      const scope = { kind: agent.kind, name };
      const conversation = Number(id) as ConversationId;
      const lease = await target.store.lease(scope);
      await target.store.erase(scope, lease, [conversation]);
      const storage = await target.store.storage(scope, lease);
      try {
        const left = (await storage.scanConversations({}, 10, undefined, context)).items.map((record) =>
          String(record.id),
        );
        assert.deepEqual(left, [id]);
      } finally {
        await storage.close(context);
      }

      await target.expire(scope);
      assertLost(await failureOf(() => target.store.erase(scope, lease, [conversation])));
      lease.lose("expired");
    },

    async "gives two scopes the same IDs and seqs, and no read of one sees the other"(target) {
      const name = crypto.randomUUID();
      const a = await open(target, { kind: "store-conformance", name });
      const b = await open(target, { kind: "store-conformance-b", name });
      const seededA = await seed(a.storage, "A");
      const seededB = await seed(b.storage, "B");
      assert.deepEqual(seededB.ids, seededA.ids);
      assert.deepEqual(seededB.seqs, seededA.seqs);
      assert.deepEqual(seededA.seqs, [1, 2, 3, 4]);
      assert.strictEqual(seededA.ids.first, 2);

      const readA = await everything(a.storage, seededA.ids, seededA.seqs);
      const readB = await everything(b.storage, seededB.ids, seededB.seqs);
      assert.deepEqual(tags(readA), new Set(["A"]));
      assert.deepEqual(tags(readB), new Set(["B"]));
      assert.deepEqual(JSON.parse(JSON.stringify(readB).replaceAll('"B"', '"A"')), readA);
      assert.deepEqual(
        readA.entries.items.map((entry) => entry.id),
        [seededA.ids.forked, seededA.ids.marker, seededA.ids.first],
      );
      assert.deepEqual(
        readA.conversations.items.map((conversation) => conversation.id),
        [ROOT_CONVERSATION_ID, seededA.ids.child],
      );
      assert.strictEqual(readA.tasks.items.length, 1);
      assert.strictEqual(readA.submissions.items.length, 1);
      assert.deepEqual(readA.rewindableNow?.value, { tag: "A", n: 2 });
      assert.deepEqual(readA.rewindableThen?.value, { tag: "A", n: 1 });

      const nextA = await a.storage.mintId();
      const nextB = await b.storage.mintId();
      assert.strictEqual(nextA, nextB);
      const entry = (id: number): StorageWrite[] => [
        { type: "entry", value: { id: id as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: "x" } },
      ];
      assert.strictEqual(await commitWrites(a.storage, entry(nextA), context), 5);
      assert.strictEqual(await commitWrites(b.storage, entry(nextB), context), 5);
      for (const opened of [a, b]) {
        await opened.storage.close(context);
        await opened.lease.release();
      }

      const a2 = await open(target, { kind: "store-conformance", name });
      assert.strictEqual(await a2.storage.mintId(), nextA + 1);
      await a2.storage.close(context);
      await a2.lease.release();

      const c = await open(target, freshScope("empty"));
      const { storage } = c;
      assert.strictEqual(await storage.mintId(), 2);
      assert.deepEqual((await storage.scanConversations({}, 10, undefined, context)).items, []);
      assert.deepEqual((await storage.scanTasks({}, 10, undefined, context)).items, []);
      assert.deepEqual((await storage.scanSubmissions({}, 10, undefined, context)).items, []);
      assert.deepEqual(
        (await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 10, undefined, context)).items,
        [],
      );
      assert.strictEqual(await storage.entry(seededA.ids.first, context), undefined);
      assert.strictEqual(await storage.task(seededA.ids.task, context), undefined);
      assert.strictEqual(await storage.document(seededA.ids.sessionDoc, "current", context), undefined);
      await assert.rejects(
        storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context),
        "Unknown conversation",
      );
      await storage.close(context);
      await c.lease.release();
    },

    async "lets each scope claim an ID another scope already uses"(target) {
      const a = await open(target, freshScope("claim-a"));
      const b = await open(target, freshScope("claim-b"));
      await commitWrites(a.storage, [root], context);
      await commitWrites(b.storage, [root], context);
      const id = 500 as EntryId;
      await commitWrites(
        a.storage,
        [{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "a" } }],
        context,
      );
      await commitWrites(
        b.storage,
        [
          {
            type: "task",
            value: {
              id: id as unknown as TaskId<JsonValue>,
              conversationId: ROOT_CONVERSATION_ID,
              kind: "b",
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
      assert.strictEqual((await a.storage.entry(id, context))?.entry.kind, "a");
      assert.strictEqual(await b.storage.entry(id, context), undefined);
      assert.strictEqual((await b.storage.task(id as unknown as TaskId, context))?.kind, "b");
      assert.strictEqual(await a.storage.task(id as unknown as TaskId, context), undefined);
      assert.strictEqual(await a.storage.mintId(), 501);
      assert.strictEqual(await b.storage.mintId(), 501);
      await a.lease.release();
      await b.lease.release();
    },

    async "deleteScope removes every row of the scope and nothing of another"(target) {
      const scopeA = freshScope("delete-a");
      const scopeB = freshScope("delete-b");
      const a = await open(target, scopeA);
      const b = await open(target, scopeB);
      const seededA = await seed(a.storage, "A");
      const seededB = await seed(b.storage, "B");
      const before = await everything(b.storage, seededB.ids, seededB.seqs);
      const rows = await target.rows(a.storage);
      assert.ok(rows.length > 0 && rows.every((n) => n > 0), `Expected rows in every table, got ${rows.join(", ")}`);
      const none = rows.map(() => 0);

      assertHeld(await failureOf(() => target.store.deleteScope(scopeA)));
      await a.lease.release();
      assert.strictEqual(await target.store.deleteScope(scopeA), true);
      assert.deepEqual(await target.rows(a.storage), none);
      assert.deepEqual(await everything(b.storage, seededB.ids, seededB.seqs), before);

      const late: StorageWrite = {
        type: "entry",
        value: { id: (await a.storage.mintId()) as EntryId, conversationId: ROOT_CONVERSATION_ID, kind: "late" },
      };
      assertLost(await failureOf(() => commitWrites(a.storage, [late], context)));
      assert.deepEqual(await target.rows(a.storage), none);

      const a2 = await open(target, scopeA);
      assert.strictEqual(await a2.storage.mintId(), 2);
      assert.strictEqual(await a2.storage.conversation(ROOT_CONVERSATION_ID, context), undefined);
      assert.strictEqual(await a2.storage.entry(seededA.ids.first, context), undefined);

      assert.strictEqual(await target.store.deleteScope(freshScope("never")), false);
      await a2.lease.release();
      await b.lease.release();
    },

    async "fails the next commit of a storage whose scope was deleted under it"(target) {
      const scope = freshScope("deleted-under");
      const { lease, storage } = await open(target, scope);
      await commitWrites(storage, [root], context);
      assert.strictEqual(await target.store.deleteScope(scope, lease), true);
      assert.strictEqual(reasonOf(lease.signal), "deleted");
      assertLost(
        await failureOf(() =>
          commitWrites(storage, [{ type: "conversation", value: { id: 9 as ConversationId } }], context),
        ),
      );
      const other = freshScope("deleted-under-2");
      const opened = await open(target, other);
      await target.remove(other);
      const error = await failureOf(() => commitWrites(opened.storage, [root], context));
      assert.ok(error instanceof ScopeDeletedError, `Expected a ScopeDeletedError, got ${String(error)}`);
      assert.strictEqual(reasonOf(opened.lease.signal), "deleted");
    },

    async "deleteScope refuses a scope another holder leases, and accepts the holder's own lease"(target) {
      const scope = freshScope("delete-leased");
      const lease = await target.store.lease(scope);
      assertHeld(await failureOf(() => target.store.deleteScope(scope)));
      assert.strictEqual(await target.store.deleteScope(scope, lease), true);
      assert.strictEqual(lease.signal.aborted, true);
      assert.strictEqual(reasonOf(lease.signal), "deleted");
    },

    async "rejects scopes a text column cannot store"(target) {
      const error = await failureOf(() => target.store.lease({ kind: "", name: "x" }));
      assert.ok(error instanceof TypeError, `Expected a TypeError, got ${String(error)}`);
      await assert.rejects(target.store.lease({ kind: "store-conformance", name: "\ud800" }), "well-formed");
      await assert.rejects(target.store.lease({ kind: "store-conformance", name: "a\0b" }), "NUL");
      await assert.rejects(target.store.lease({ kind: "store-conformance", name: "x".repeat(1025) }), "at most 1024");
      await assert.rejects(target.store.deleteScope({ kind: "store-conformance", name: "\udc00" }), "well-formed");
    },
  };

  runner.describe(name, () => {
    for (const [title, run] of Object.entries(cases)) runner.it(title, () => provider(run));
  });
}
