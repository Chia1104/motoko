// Two nodes on one database: a call or follow sent to a node that is not the instance's home is forwarded to the home,
// which authenticates it again; handover, graceful and after a crash; and what is never forwarded.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { httpTransport, motokoClient, MotokoError } from "@chia1104/motoko-client";
import type { MotokoTransport } from "@chia1104/motoko-client";
import { scopeKey } from "@chia1104/motoko-core";
import type { AgentRuntime } from "@chia1104/motoko-core";
import { FORWARDED_BY } from "@chia1104/motoko-node";
import { decodeCursor, foldEvents } from "@chia1104/motoko-wire";
import type { StreamItem } from "@chia1104/motoko-wire";

import { call, eventually, follow, isRunEnd, readUntil } from "./http.ts";
import { agent, cluster, faux, pgliteDatabase, postgresDatabase, resolveUser, scopeOf, uniqueName } from "./nodes.ts";
import type { ClusterNode, Database } from "./nodes.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const databases = [
  { name: "PGlite", open: pgliteDatabase, skip: false },
  { name: "Postgres", open: () => postgresDatabase(DATABASE_URL!), skip: DATABASE_URL === undefined },
];

const readersOf = (runtime: AgentRuntime) => runtime.inspect().instances.reduce((sum, { readers }) => sum + readers, 0);
const types = (items: readonly StreamItem[]) => items.map((item) => item.event.type);
/** Each event, with the committed position its cursor names, without the place in one process's log. */
const committed = (items: readonly StreamItem[]) =>
  items.map(({ cursor, event }) => {
    const { log: _log, ...position } = decodeCursor(cursor)!;
    return { position, event };
  });

/** A reader of a session on `runtime` directly, in the background, from `from`. */
function reader(runtime: AgentRuntime, name: string, sessionId: string, from?: string) {
  const controller = new AbortController();
  const items: StreamItem[] = [];
  const session = runtime.get(agent, name).session(sessionId);
  const done = (async () => {
    for await (const item of session.events({ ...(from !== undefined && { from }), signal: controller.signal })) {
      items.push(item);
    }
  })().catch(() => undefined);
  return {
    items,
    async stop() {
      controller.abort();
      await done;
    },
  };
}

/** `transport`, keeping every event and drop its follows had. */
function recording(transport: MotokoTransport) {
  const events: StreamItem[] = [];
  let drops = 0;
  const recorder: MotokoTransport = {
    call: transport.call.bind(transport),
    follow: (sessionId, from, listener) =>
      transport.follow(sessionId, from, {
        ...listener,
        event: (item) => {
          events.push(item);
          listener.event(item);
        },
        dropped: () => {
          drops += 1;
          listener.dropped();
        },
      }),
  };
  return { transport: recorder, events, drops: () => drops };
}

/** `fetch` whose follows wait while the door is shut; calls always go through. */
function door() {
  let opened = Promise.resolve();
  let open = () => undefined as void;
  return {
    fetch: async (input: string, init: RequestInit) => {
      if (input.endsWith("/events")) await opened;
      return fetch(input, init);
    },
    shut() {
      opened = new Promise((resolve) => (open = resolve));
    },
    open: () => open(),
  };
}

for (const { name, open, skip } of databases) {
  describe.skipIf(skip)(`Two nodes on ${name}`, () => {
    let database: Database;
    let nodes: ReturnType<typeof cluster>;
    beforeAll(async () => {
      database = await open();
    });
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(() => {
      nodes = cluster(database);
    });
    afterEach(async () => {
      await nodes.close();
    });

    /** A user whose instance `home` holds, with the credentials that name them and a session of theirs. */
    async function userAt(home: ClusterNode) {
      const user = uniqueName("alice");
      const instance = home.runtime.get(agent, user);
      const session = await instance.createSession();
      return { user, as: { authorization: `Bearer ${user}` }, instance, session };
    }

    it("forwards each call to the instance's home, which runs it once, and never opens it here", async () => {
      const a = await nodes.start();
      const b = await nodes.start();
      const user = uniqueName("alice");
      await b.runtime.get(agent, user).open();
      const as = { authorization: `Bearer ${user}` };

      const created = await call(a.url, "createSession", { requestId: "c1" }, as);
      expect(created).toMatchObject({ status: 200, body: { result: { id: expect.any(String) } } });
      const session = created.body!.result as { id: string };
      const onB = reader(b.runtime, user, session.id);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("send", { to: "bob" }, { id: "call-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Sent."),
      ]);
      const submitted = await call(a.url, "submit", { sessionId: session.id, text: "Tell Bob", requestId: "s1" }, as);
      expect(submitted).toMatchObject({ status: 200, body: { result: { submissionId: expect.any(String) } } });
      await eventually(() => types(onB.items).includes("approval:request"));
      const decisions = [{ toolCallId: "call-1", approved: true }];
      expect(await call(a.url, "approve", { sessionId: session.id, decisions }, as)).toMatchObject({
        status: 200,
        body: { result: [{ toolCallId: "call-1", outcome: "applied" }] },
      });
      await eventually(() => types(onB.items).includes("run:end"));
      await onB.stop();
      expect(await call(a.url, "listSessions", {}, as)).toMatchObject({ status: 200, body: { result: [session] } });

      // Each ran once, on B, as the client sent it: with its credentials, and marked as A's forward.
      expect(nodes.sent).toEqual([{ node: b.url, to: "bob" }]);
      expect(b.received.map((request) => request.call)).toEqual(["createSession", "submit", "approve", "listSessions"]);
      for (const request of b.received) {
        expect(request.headers.get("authorization")).toBe(as.authorization);
        expect(request.headers.get(FORWARDED_BY)).toBe(a.url);
      }
      expect(await b.runtime.get(agent, user).listSessions()).toEqual([session]);
      // A asked for the lease and was refused; it opened nothing.
      expect(a.opened).toEqual([]);
      expect(a.runtime.inspect().open).toBe(0);
      expect(await database.lease(scopeOf(user))).toEqual({ holder: b.url, held: true });
      expect([...a.reported, ...b.reported]).toEqual([]);
    });

    it("streams a follow from the home, event for event, and ends its request there when the client leaves", async () => {
      const a = await nodes.start();
      const b = await nodes.start();
      const { as, instance, session } = await userAt(b);

      const throughA = await follow(a.url, session.id, as);
      const direct = await follow(b.url, session.id, as);
      expect(throughA.response.status).toBe(200);
      expect(throughA.response.headers.get("content-type")).toBe("text/event-stream");
      faux.setResponses([fauxAssistantMessage("Hello there.")]);
      await instance.session(session.id).submit({ text: "Hi", requestId: "s1" });

      const relayed = await readUntil(throughA.frames, isRunEnd);
      expect(relayed).toEqual(await readUntil(direct.frames, isRunEnd));
      expect(relayed.length).toBeGreaterThan(2);
      for (const { id, cursor } of relayed) expect(id).toBe(cursor);
      expect(b.received.filter((request) => request.headers.has(FORWARDED_BY))).toHaveLength(1);

      // Two readers on B: the direct follow's and A's. A's client goes away, and A ends its request to B.
      expect(readersOf(b.runtime)).toBe(2);
      throughA.disconnect();
      await eventually(() => readersOf(b.runtime) === 1);
      direct.disconnect();
      expect(a.opened).toEqual([]);
    });

    it("passes back the home's refusal of a caller unchanged", async () => {
      const signedOut = new Set<string>();
      const a = await nodes.start();
      const b = await nodes.start({
        // B has heard of a sign-out that A has not: A lets the caller in, B does not.
        resolve(request) {
          const target = resolveUser(request);
          if (target instanceof Response || !signedOut.has(target.name)) return target;
          return new Response("Signed out", {
            status: 401,
            headers: { "www-authenticate": 'Bearer error="invalid_token"' },
          });
        },
        authorize: (_request, httpCall) => httpCall.method !== "deleteSession",
      });
      const { user, as, instance, session } = await userAt(b);

      signedOut.add(user);
      const refused = await call(a.url, "listSessions", {}, as);
      expect(refused).toMatchObject({ status: 401, text: "Signed out" });
      expect(refused.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
      const followRefused = await follow(a.url, session.id, as);
      expect(followRefused.response.status).toBe(401);
      expect(await followRefused.response.text()).toBe("Signed out");

      signedOut.clear();
      expect(await call(a.url, "deleteSession", { sessionId: session.id }, as)).toMatchObject({
        status: 403,
        body: { error: { code: "forbidden", message: "This request may not deleteSession" } },
      });
      expect(await instance.listSessions()).toEqual([session]);
      expect(b.received.map((request) => request.headers.get(FORWARDED_BY))).toEqual([a.url, a.url, a.url]);
    });

    it("answers a request forwarded once already 503 lease_held, and forwards it no further", async () => {
      const a = await nodes.start();
      const b = await nodes.start();
      const { as, session } = await userAt(b);
      const forwarded = { ...as, [FORWARDED_BY]: "http://127.0.0.1:9/motoko" };

      const answer = await call(a.url, "listSessions", {}, forwarded);
      expect(answer).toMatchObject({ status: 503, body: { error: { code: "lease_held" } } });
      expect(answer.headers.get("retry-after")).toMatch(/^\d+$/);
      const followed = await follow(a.url, session.id, forwarded);
      expect(followed.response.status).toBe(503);
      expect(await followed.response.json()).toMatchObject({ error: { code: "lease_held" } });
      expect(b.received).toEqual([]);
    });

    it("sends a holder that is not a peer nothing, so none of the caller's credentials", async () => {
      const a = await nodes.start({ peers: [] });
      const b = await nodes.start();
      const { as, session } = await userAt(b);
      const credentials = { ...as, cookie: "sid=secret" };

      expect(await call(a.url, "listSessions", {}, credentials)).toMatchObject({
        status: 503,
        body: { error: { code: "lease_held" } },
      });
      expect((await follow(a.url, session.id, credentials)).response.status).toBe(503);
      expect(b.received).toEqual([]);
    });

    it("forwards nothing to itself, nor to a holder that is not an http(s) URL", async () => {
      const a = await nodes.start({ peers: () => true });
      // A lease that names A, left by A's process before this one, and one that names no URL: `hostname:pid`.
      const [stale, unnamed] = [
        database.store({ holder: a.url }).store,
        database.store({ holder: "worker-7:4242" }).store,
      ];
      const [mine, theirs] = [uniqueName("alice"), uniqueName("bob")];
      const leases = [await stale.lease(scopeOf(mine)), await unnamed.lease(scopeOf(theirs))];
      try {
        for (const user of [mine, theirs]) {
          expect(await call(a.url, "listSessions", {}, { authorization: `Bearer ${user}` })).toMatchObject({
            status: 503,
            body: { error: { code: "lease_held" } },
          });
        }
        // Only the two calls themselves: A never sent one to itself.
        expect(a.received.map((request) => request.headers.has(FORWARDED_BY))).toEqual([false, false]);
      } finally {
        await Promise.all(leases.map((lease) => lease.release()));
      }
    });

    it("answers 503 lease_held when the home cannot be reached in connectTimeoutMs", async () => {
      // TEST-NET-1: nothing answers there, so a connect waits until it times out (or fails at once, offline).
      const unreachable = "http://192.0.2.1:9/motoko";
      const a = await nodes.start({ peers: [unreachable], connectTimeoutMs: 200 });
      const user = uniqueName("alice");
      const lease = await database.store({ holder: unreachable }).store.lease(scopeOf(user));
      try {
        const started = performance.now();
        const answer = await call(a.url, "listSessions", {}, { authorization: `Bearer ${user}` });
        expect(answer).toMatchObject({ status: 503, body: { error: { code: "lease_held" } } });
        expect(performance.now() - started).toBeLessThan(1_500);
      } finally {
        await lease.release();
      }
    });

    it("hands an instance over when its home shuts down, and a follow resumes with exactly what it missed", async () => {
      const a = await nodes.start();
      const b = await nodes.start();
      const user = uniqueName("alice");
      await b.runtime.get(agent, user).open();
      const gate = door();
      const { transport, events, drops } = recording(
        httpTransport({ baseUrl: a.url, headers: { authorization: `Bearer ${user}` }, fetch: gate.fetch }),
      );
      const client = motokoClient(transport);
      const session = await client.createSession();
      const stop = client.follow(session.id, () => undefined);
      await eventually(() => client.sessionState(session.id).status === "live");
      faux.setResponses([fauxAssistantMessage("First.")]);
      await client.submit(session.id, { text: "One", requestId: "s1" });
      await eventually(() => types(events).includes("run:end"));
      const before = events.length;
      const cursor = client.sessionState(session.id).cursor!;

      // B shuts down: it releases the lease, and its follow ends without `ended`, so A's does too.
      gate.shut();
      const forwardedToB = b.received.length;
      await b.close();
      await eventually(() => drops() === 1);
      expect(client.sessionState(session.id).status).toBe("connecting");

      // A's next call takes the lease and runs here.
      faux.setResponses([fauxAssistantMessage("Second.")]);
      await client.submit(session.id, { text: "Two", requestId: "s2" });
      expect(a.opened).toEqual([scopeKey(scopeOf(user))]);
      expect(await database.lease(scopeOf(user))).toEqual({ holder: a.url, held: true });
      const missed = await readDirectUntilRunEnd(a.runtime, user, session.id, cursor);

      gate.open();
      await eventually(() => types(events).filter((type) => type === "run:end").length === 2);
      stop();
      // From its cursor, the client got what a reader of A from that cursor gets: run two, and nothing of run one. (Each
      // reader joins A's log at a place of its own, which only the cursors' log part names.)
      expect(committed(events.slice(before))).toEqual(committed(missed));
      expect(types(missed).filter((type) => type === "run:start")).toHaveLength(1);
      expect(foldEvents(events.map((item) => item.event))).toEqual(
        foldEvents((await readDirectUntilRunEnd(a.runtime, user, session.id, undefined, 2)).map((item) => item.event)),
      );
      expect(b.received).toHaveLength(forwardedToB);
      client.close();
    });

    it("takes over a crashed home's instance once its lease expires, answering 503 until then", async () => {
      const ttlMs = 1_000;
      const a = await nodes.start({ ttlMs });
      const b = await nodes.start({ ttlMs });
      const { user, as, session } = await userAt(b);

      await b.crash();
      const crashedAt = performance.now();
      const refusals: { status: number; code: unknown; retryAfter: string | null }[] = [];
      let answer = await call(a.url, "listSessions", {}, as);
      while (answer.status !== 200 && performance.now() - crashedAt < 5 * ttlMs) {
        refusals.push({
          status: answer.status,
          code: (answer.body?.error as { code?: unknown } | undefined)?.code,
          retryAfter: answer.headers.get("retry-after"),
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        answer = await call(a.url, "listSessions", {}, as);
      }
      const failoverMs = performance.now() - crashedAt;

      expect(answer).toMatchObject({ status: 200, body: { result: [session] } });
      expect(refusals.length).toBeGreaterThan(0);
      // Retry-After: the whole seconds left of B's lease, which is at most ttlMs.
      for (const refusal of refusals) {
        expect(refusal).toEqual({ status: 503, code: "lease_held", retryAfter: expect.stringMatching(/^[01]$/) });
      }
      // B's last renewal was at most a renewal interval (ttlMs / 3) before the crash, and its lease lasts ttlMs past it.
      expect(failoverMs).toBeGreaterThan(ttlMs - ttlMs / 3 - 50);
      expect(failoverMs).toBeLessThan(ttlMs + 500);
      expect(a.opened).toEqual([scopeKey(scopeOf(user))]);
      expect(await database.lease(scopeOf(user))).toEqual({ holder: a.url, held: true });
    });

    it("asks across two nodes: the asked home's reply is forwarded to the asker's home, and the call returns it", async () => {
      const a = await nodes.start();
      const b = await nodes.start();
      const [alice, bob] = [uniqueName("alice"), uniqueName("bob")];
      const asker = a.runtime.get(agent, alice);
      const asking = await asker.createSession();
      const asked = await b.runtime.get(agent, bob).createSession();
      // Alice's request, Bob's, then Alice's again: the runs ask the one model in this order.
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("ask", { user: bob, sessionId: asked.id, question: "Why?" }, { id: "q-1" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Because."),
        fauxAssistantMessage("Bob says because."),
      ]);
      const session = asker.session(asking.id);
      await session.submit({ text: "Ask Bob why", requestId: "s1" });
      const items = await readDirectUntilRunEnd(a.runtime, alice, asking.id, undefined);

      const result = foldEvents(items.map((item) => item.event)).items.find((item) => item.kind === "tool");
      expect(result).toMatchObject({ toolName: "ask", status: "ok" });
      expect(types(items)).toContain("reply:wait");
      // The reply resumed the call before B's request for it was answered.
      await eventually(() => nodes.replied.length === 1);
      expect(nodes.replied).toEqual([{ node: b.url, outcome: "applied" }]);
      const bobs = await readDirectUntilRunEnd(b.runtime, bob, asked.id, undefined);
      expect(foldEvents(bobs.map((item) => item.event)).items).toMatchObject([
        { kind: "user", text: "Why?" },
        { kind: "assistant", text: "Because." },
      ]);
      // A's `start` asked through A, which forwarded the ask to Bob's home; B's reply went through B, which forwarded
      // it to Alice's. Neither instance opened anywhere but at its home.
      expect(b.received.filter((request) => request.call === "submit")).toHaveLength(1);
      expect(b.received.find((request) => request.call === "submit")?.headers.get(FORWARDED_BY)).toBe(a.url);
      expect(a.received.find((request) => request.call === "reply")?.headers.get(FORWARDED_BY)).toBe(b.url);
      expect(a.opened).toEqual([scopeKey(scopeOf(alice))]);
      expect(b.opened).toEqual([scopeKey(scopeOf(bob))]);
      expect([...a.reported, ...b.reported]).toEqual([]);
    });

    it("makes one session of a createSession retried after its forward was cut off", async () => {
      const a = await nodes.start();
      const b = await nodes.start();
      const { as, instance, session } = await userAt(b);
      const client = motokoClient(httpTransport({ baseUrl: a.url, headers: as }));

      b.cutAfterRunning("createSession");
      const requestId = "create-1";
      const cut = await client.createSession({ requestId }).catch((error: unknown) => error);
      expect(cut).toBeInstanceOf(MotokoError);
      expect((cut as MotokoError).code).toBe("connection_closed");
      // It ran on B before the connection was cut.
      expect(await instance.listSessions()).toHaveLength(2);

      const retried = await client.createSession({ requestId });
      expect(await client.listSessions()).toEqual([session, retried]);
      expect(b.received.filter((request) => request.call === "createSession")).toHaveLength(2);
      client.close();
    });
  });
}

/** The events of a session on `runtime` after `from`, read there directly until `runs` runs end. */
async function readDirectUntilRunEnd(
  runtime: AgentRuntime,
  name: string,
  sessionId: string,
  from: string | undefined,
  runs = 1,
): Promise<StreamItem[]> {
  const controller = new AbortController();
  const items: StreamItem[] = [];
  const session = runtime.get(agent, name).session(sessionId);
  for await (const item of session.events({ ...(from !== undefined && { from }), signal: controller.signal })) {
    items.push(item);
    if (types(items).filter((type) => type === "run:end").length === runs) break;
  }
  controller.abort();
  return items;
}
