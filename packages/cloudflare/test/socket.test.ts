import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { motokoClient, webSocketTransport } from "@chia1104/motoko-client";
import type { MotokoClient, MotokoSessionState, MotokoSocket } from "@chia1104/motoko-client";
import { delegateOf, emptySessionView, foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, Cursor, ToolItem } from "@chia1104/motoko-wire";

import { eventually, unhandledRejections } from "./helpers.ts";

const OPEN = 1;
const CLOSED = 3;

/**
 * A socket to one object that the test drops and opens again, as `AgentClient` reconnects on its own: one object the
 * client holds, a new connection each time. It keeps every event frame it received, the stream as the wire carried it.
 */
class TestSocket extends EventTarget implements MotokoSocket {
  readyState = CLOSED;
  readonly events: { readonly sessionId: string; readonly cursor: Cursor; readonly event: AgentWireEvent }[] = [];
  readonly frames: Record<string, unknown>[] = [];
  #ws: WebSocket | undefined;
  /** A stub of the object for each connection: a stub dies with the object instance it reached. */
  readonly #stub: () => { fetch(input: string, init: RequestInit): Promise<Response> };
  /** The upgrade's URL: `?readonly` has the SDK mark the connection readonly, `?_pk=` names it. */
  readonly #url: string;

  constructor(stub: () => { fetch(input: string, init: RequestInit): Promise<Response> }, url = "http://motoko.test/") {
    super();
    this.#stub = stub;
    this.#url = url;
  }

  async connect(): Promise<this> {
    const response = await this.#stub().fetch(this.#url, { headers: { Upgrade: "websocket" } });
    const ws = response.webSocket;
    if (ws === null) throw new Error(`No WebSocket: ${response.status}`);
    ws.accept();
    ws.addEventListener("message", ({ data }) => {
      if (typeof data === "string") {
        const frame = JSON.parse(data) as Record<string, unknown>;
        this.frames.push(frame);
        if (frame.type === "motoko:event") this.events.push(frame as never);
      }
      this.dispatchEvent(new MessageEvent("message", { data }));
    });
    // The server closed it, as an object that is reset does.
    ws.addEventListener("close", () => {
      if (this.#ws === ws) this.#closed();
    });
    this.#ws = ws;
    this.readyState = OPEN;
    this.dispatchEvent(new Event("open"));
    return this;
  }

  disconnect(): void {
    this.#ws?.close(1000, "bye");
    this.#closed();
  }

  #closed() {
    this.#ws = undefined;
    this.readyState = CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  send(data: string): void {
    if (this.#ws === undefined) throw new Error("Not connected");
    this.#ws.send(data);
  }

  /** The event frames of `sessionId` received since `start`. */
  eventsOf(sessionId: string, start = 0): AgentWireEvent[] {
    return this.events
      .filter((item) => item.sessionId === sessionId)
      .slice(start)
      .map((item) => item.event);
  }
}

const agent = (name: string = crypto.randomUUID()) => env.MOTOKO.getByName(name);

/** The socket's Motoko client, as a browser makes it: one per socket. */
const clientOf = (socket: MotokoSocket) => motokoClient(webSocketTransport(socket));

/** Waits until the session's state satisfies `condition`, then returns it. */
async function until(
  client: MotokoClient,
  sessionId: string,
  condition: (state: MotokoSessionState) => boolean,
): Promise<MotokoSessionState> {
  await eventually(async () => condition(client.sessionState(sessionId)));
  return client.sessionState(sessionId);
}

const runEnded = (socket: TestSocket, sessionId: string, runs = 1) =>
  eventually(async () => socket.eventsOf(sessionId).filter((event) => event.type === "run:end").length >= runs);

/** What a session view shows, without its stream ids. */
const shape = (state: MotokoSessionState) =>
  state.view.items.map((item) =>
    item.kind === "tool"
      ? { kind: item.kind, toolName: item.toolName, status: item.status, approval: item.approval }
      : item.kind === "notice"
        ? { kind: item.kind, reason: item.reason }
        : { kind: item.kind, text: "text" in item ? item.text : item.summary },
  );

describe("a socket client of an Agent with Motoko installed", () => {
  it("subscribes, submits and receives the run's events in order, folded into the session view", async () => {
    const stub = agent();
    await stub.script([{ tool: "shout", args: { text: "hi" } }, { text: "It said HI." }]);
    const socket = await new TestSocket(() => stub).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    expect(await client.listSessions()).toEqual([{ id: sessionId, createdAt: expect.any(Number) }]);

    const states: MotokoSessionState["status"][] = [];
    const unfollow = client.follow(sessionId, (state) => states.push(state.status));
    await until(client, sessionId, (state) => state.status === "live");
    const { submissionId } = await client.submit(sessionId, { text: "Shout hi", requestId: "r-1" });
    expect(submissionId).toEqual(expect.any(String));
    // The same request again is the same submission, and starts nothing.
    expect(await client.submit(sessionId, { text: "Shout hi", requestId: "r-1" })).toEqual({ submissionId });
    await runEnded(socket, sessionId);

    // The run as it happened (pi-ai's faux model answers whole, without streaming): its start, the message, the reply
    // that called the tool, the call, the answer, its end.
    expect(socket.eventsOf(sessionId).map((event) => event.type)).toEqual([
      "run:start",
      "user",
      "assistant:end",
      "tool:start",
      "tool:end",
      "assistant:end",
      "run:end",
    ]);
    const state = client.sessionState(sessionId);
    expect(shape(state)).toEqual([
      { kind: "user", text: "Shout hi" },
      { kind: "assistant", text: "" },
      { kind: "tool", toolName: "shout", status: "ok", approval: undefined },
      { kind: "assistant", text: "It said HI." },
    ]);
    expect(state.view.status).toBe("idle");
    // The view is the session's whole stream folded, as a client reading it from the start would build it.
    expect(state.view).toEqual(foldEvents(socket.eventsOf(sessionId), emptySessionView()));
    expect(states[0]).toBe("live");
    unfollow();
  });

  it("follows a delegate's child session from the parent's call, and gets the child's answer back", async () => {
    const stub = agent();
    // The parent's request, the child's, then the parent's again: one model, in the order the runs ask it.
    await stub.script([{ tool: "ask", args: { task: "Shout hi" } }, { text: "HI" }, { text: "The helper said HI." }]);
    const socket = await new TestSocket(() => stub).connect();
    const client = clientOf(socket);
    const { id: parentId } = await client.createSession();
    const unfollow = client.follow(parentId, () => undefined);
    await until(client, parentId, (state) => state.status === "live");
    await client.submit(parentId, { text: "Ask the helper", requestId: "r-1" });

    const call = (state: MotokoSessionState) =>
      state.view.items.find((item) => item.kind === "tool" && item.toolName === "ask");
    const child = (state: MotokoSessionState) => {
      const item = call(state);
      return item?.kind === "tool" ? delegateOf(item) : undefined;
    };
    const { sessionId: childId, agent: kind } = child(
      await until(client, parentId, (state) => child(state) !== undefined),
    )!;
    expect(kind).toBe("helper");
    const unfollowChild = client.follow(childId, () => undefined);
    await runEnded(socket, childId);
    await runEnded(socket, parentId);

    expect(shape(client.sessionState(childId))).toEqual([
      { kind: "user", text: "Shout hi" },
      { kind: "assistant", text: "HI" },
    ]);
    expect(shape(client.sessionState(parentId))).toEqual([
      { kind: "user", text: "Ask the helper" },
      { kind: "assistant", text: "" },
      { kind: "tool", toolName: "ask", status: "ok", approval: undefined },
      { kind: "assistant", text: "The helper said HI." },
    ]);
    // Only its delegate submits to the child, and only the parent is listed.
    await expect(client.submit(childId, { text: "Again", requestId: "r-2" })).rejects.toMatchObject({
      code: "session_owned",
    });
    expect(await client.listSessions()).toEqual([{ id: parentId, createdAt: expect.any(Number) }]);
    unfollowChild();
    unfollow();
  });

  it("parks a deferred call in the object, which a reply over the socket resumes, the object evicted meanwhile", async () => {
    const name = crypto.randomUUID();
    const stub = agent(name);
    // No `to`: the call asks nobody, and the test replies itself.
    await stub.script([{ tool: "relay", args: { to: "", session: "", text: "Why?" } }, { text: "It said because." }]);
    const socket = await new TestSocket(() => agent(name)).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    const unfollow = client.follow(sessionId, () => undefined);
    await until(client, sessionId, (state) => state.status === "live");
    await client.submit(sessionId, { text: "Ask", requestId: "r-1" });
    const call = (state: MotokoSessionState) =>
      state.view.items.find((item): item is ToolItem => item.kind === "tool" && item.toolName === "relay");
    await until(client, sessionId, (state) => call(state)?.status === "awaiting_reply");
    const address = (await stub.replyAddress())!;
    expect(address).toEqual({
      scope: { kind: "assistant", name },
      sessionId,
      toolCallId: expect.any(String),
      token: expect.any(String),
    });

    // The object leaves memory while the call waits: the park is stored state, and nothing of it runs.
    await evictDurableObject(stub);
    const { toolCallId, token } = address;
    await expect(client.reply(sessionId, { toolCallId, token: "forged", text: "No." })).rejects.toMatchObject({
      code: "reply_not_pending",
    });
    expect(await client.reply(sessionId, { toolCallId, token, text: "Because." })).toEqual({ outcome: "applied" });
    await runEnded(socket, sessionId);
    expect(shape(client.sessionState(sessionId))).toEqual([
      { kind: "user", text: "Ask" },
      { kind: "assistant", text: "" },
      { kind: "tool", toolName: "relay", status: "ok", approval: undefined },
      { kind: "assistant", text: "It said because." },
    ]);
    expect(socket.eventsOf(sessionId).map((event) => event.type)).toContain("reply:wait");
    expect(await client.reply(sessionId, { toolCallId, token, text: "Again." })).toEqual({
      outcome: "already_replied",
    });
    unfollow();
  });

  it("resumes after a reconnect from its last cursor, with exactly the events it missed", async () => {
    const stub = agent();
    await stub.script([{ hold: true }]);
    const watcher = await new TestSocket(() => stub).connect();
    const socket = await new TestSocket(() => stub).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    clientOf(watcher).follow(sessionId, () => undefined);
    client.follow(sessionId, () => undefined);
    await until(client, sessionId, (state) => state.status === "live");
    await until(clientOf(watcher), sessionId, (state) => state.status === "live");

    await client.submit(sessionId, { text: "Work", requestId: "r-1" });
    await eventually(async () => (await stub.requests()) === 1);
    await eventually(async () => socket.eventsOf(sessionId).some((event) => event.type === "run:start"));
    const before = socket.eventsOf(sessionId).length;

    socket.disconnect();
    expect(client.sessionState(sessionId).status).toBe("connecting");
    // The run goes on without this client: the held request answers, the reply streams and the run ends.
    expect(await stub.release("Carried on.")).toBe(true);
    await runEnded(watcher, sessionId);
    const missed = watcher.eventsOf(sessionId, before);
    expect(missed.map((event) => event.type)).toContain("assistant:end");

    await socket.connect();
    await until(client, sessionId, (state) => state.status === "live" && state.view.status === "idle");
    await runEnded(socket, sessionId);
    // Neither a gap nor a duplicate: what it got after the reconnect is what the connected client got meanwhile.
    expect(socket.eventsOf(sessionId, before)).toEqual(missed);
    expect(socket.eventsOf(sessionId)).toEqual(watcher.eventsOf(sessionId));
    expect(client.sessionState(sessionId).view).toEqual(clientOf(watcher).sessionState(sessionId).view);
  });

  it("decides a parked approval over the socket, and answers calls with typed errors", async () => {
    const stub = agent();
    await stub.script([{ tool: "save", args: { text: "milk" } }, { text: "Saved it." }]);
    const socket = await new TestSocket(() => stub).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    client.follow(sessionId, () => undefined);
    await client.submit(sessionId, { text: "Save milk", requestId: "r-1" });

    const parked = await until(client, sessionId, (state) => state.view.status === "awaiting_approval");
    const [toolCallId] = parked.view.pendingApprovals;
    expect(toolCallId).toEqual(expect.any(String));
    // A run is going, so a submission that refuses to queue is refused.
    await expect(
      client.submit(sessionId, { text: "Another", requestId: "r-2", whenBusy: "reject" }),
    ).rejects.toMatchObject({ code: "session_busy" });

    expect(await client.approve(sessionId, [{ toolCallId: toolCallId!, approved: true }])).toEqual([
      { toolCallId, outcome: "applied" },
    ]);
    const done = await until(client, sessionId, (state) => state.view.status === "idle");
    expect(shape(done)).toEqual([
      { kind: "user", text: "Save milk" },
      { kind: "assistant", text: "" },
      { kind: "tool", toolName: "save", status: "ok", approval: { approved: true } },
      { kind: "assistant", text: "Saved it." },
    ]);

    await expect(client.approve(sessionId, [{ toolCallId: toolCallId!, approved: false }])).rejects.toMatchObject({
      code: "approval_not_pending",
    });
    await expect(client.submit("999999", { text: "Nobody", requestId: "r-3" })).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(client.abort(sessionId)).resolves.toBeUndefined();
  });

  it("ends a follow when its session is deleted, and refuses a cursor of another session", async () => {
    const stub = agent();
    const socket = await new TestSocket(() => stub).connect();
    const client = clientOf(socket);
    const { id: kept } = await client.createSession();
    const { id: doomed } = await client.createSession();
    client.follow(doomed, () => undefined);
    await until(client, doomed, (state) => state.status === "live");

    await client.deleteSession(doomed);
    const ended = await until(client, doomed, (state) => state.status === "ended");
    expect(ended.error?.code).toBe("session_not_found");
    expect((await client.listSessions()).map((session) => session.id)).toEqual([kept]);

    socket.send(
      JSON.stringify({
        type: "motoko:call",
        id: "x-1",
        method: "subscribe",
        params: { sessionId: kept, from: `${doomed}.0.-` },
      }),
    );
    socket.send(JSON.stringify({ type: "motoko:call", id: "x-2", method: "shout", params: {} }));
    await eventually(async () => socket.frames.filter((frame) => frame.type === "motoko:error").length === 2);
    expect(socket.frames.filter((frame) => frame.type === "motoko:error")).toEqual([
      { type: "motoko:error", id: "x-1", error: { code: "invalid_cursor", message: expect.any(String) } },
      { type: "motoko:error", id: "x-2", error: { code: "invalid_request", message: expect.any(String) } },
    ]);
  });

  it("lets a readonly connection follow and list sessions, and refuses every call of it that writes", async () => {
    const stub = agent();
    await stub.script([{ tool: "save", args: { text: "milk" } }, { text: "Saved it." }]);
    const writer = clientOf(await new TestSocket(() => stub).connect());
    const { id: sessionId } = await writer.createSession();
    writer.follow(sessionId, () => undefined);
    await writer.submit(sessionId, { text: "Save milk", requestId: "r-1" });
    const parked = await until(writer, sessionId, (state) => state.view.status === "awaiting_approval");
    const [toolCallId] = parked.view.pendingApprovals;

    const observer = await new TestSocket(() => stub, "http://motoko.test/?readonly").connect();
    const client = clientOf(observer);
    expect((await client.listSessions()).map((session) => session.id)).toEqual([sessionId]);
    client.follow(sessionId, () => undefined);
    const seen = await until(client, sessionId, (state) => state.view.status === "awaiting_approval");
    expect(seen.view).toEqual(parked.view);

    const forbidden = { code: "forbidden" };
    await expect(client.submit(sessionId, { text: "Sneak in", requestId: "r-2" })).rejects.toMatchObject(forbidden);
    await expect(client.approve(sessionId, [{ toolCallId: toolCallId!, approved: false }])).rejects.toMatchObject(
      forbidden,
    );
    await expect(client.abort(sessionId)).rejects.toMatchObject(forbidden);
    await expect(client.deleteSession(sessionId)).rejects.toMatchObject(forbidden);
    await expect(client.createSession()).rejects.toMatchObject(forbidden);

    // None of it ran: the approval is still the writer's to decide, and the run ends having taken one message.
    expect(await writer.approve(sessionId, [{ toolCallId: toolCallId!, approved: true }])).toEqual([
      { toolCallId, outcome: "applied" },
    ]);
    await runEnded(observer, sessionId);
    expect(observer.eventsOf(sessionId).filter((event) => event.type === "user")).toHaveLength(1);
    expect(await stub.requests()).toBe(2);
    expect((await writer.listSessions()).map((session) => session.id)).toEqual([sessionId]);
    // It still followed the whole run.
    expect(shape(client.sessionState(sessionId))).toEqual([
      { kind: "user", text: "Save milk" },
      { kind: "assistant", text: "" },
      { kind: "tool", toolName: "save", status: "ok", approval: { approved: true } },
      { kind: "assistant", text: "Saved it." },
    ]);
  });

  it("asks the app's authorize about every call, with its connection and parsed params, before running it", async () => {
    const stub = agent(`guarded:${crypto.randomUUID()}`);
    await stub.script([{ text: "Hi." }]);
    const socket = await new TestSocket(() => stub, "http://motoko.test/?_pk=alice").connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession({ requestId: "c-1" });
    await client.submit(sessionId, { text: "Hello", requestId: "r-1" });

    // The session has its run's events ready: the result still goes out before the first of them.
    const call = (id: string, method: string, params: unknown) =>
      socket.send(JSON.stringify({ type: "motoko:call", id, method, params }));
    call("s-1", "subscribe", { sessionId, ignored: true });
    await runEnded(socket, sessionId);
    const result = socket.frames.findIndex((frame) => frame.id === "s-1");
    expect(socket.frames[result]).toEqual({ type: "motoko:result", id: "s-1", result: null });
    expect(result).toBeLessThan(socket.frames.findIndex((frame) => frame.type === "motoko:event"));

    // Refused: answered `forbidden`, and the session is still there.
    await expect(client.deleteSession(sessionId)).rejects.toMatchObject({ code: "forbidden" });
    expect((await client.listSessions()).map((session) => session.id)).toEqual([sessionId]);
    // A throw is the app's failure, not the client's to read.
    await expect(client.abort(sessionId)).rejects.toMatchObject({ code: "internal", message: "Internal error" });

    expect(await stub.authorized()).toEqual([
      { connection: "alice", method: "createSession", params: { requestId: "c-1" } },
      { connection: "alice", method: "submit", params: { sessionId, text: "Hello", requestId: "r-1" } },
      // Parsed: the key the schema does not know is gone.
      { connection: "alice", method: "subscribe", params: { sessionId } },
      { connection: "alice", method: "deleteSession", params: { sessionId } },
      { connection: "alice", method: "listSessions", params: {} },
      { connection: "alice", method: "abort", params: { sessionId } },
    ]);
  });

  it("leaves the app's own frames on the same socket to the app", async () => {
    const stub = agent();
    const socket = await new TestSocket(() => stub).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    client.follow(sessionId, () => undefined);
    await until(client, sessionId, (state) => state.status === "live");

    socket.send(JSON.stringify({ type: "echo", text: "mine" }));
    await eventually(async () => socket.frames.some((frame) => frame.type === "echoed"));
    expect(socket.frames.find((frame) => frame.type === "echoed")).toEqual({ type: "echoed", text: "mine" });
    // The app saw its frame and none of Motoko's.
    expect(await stub.seen()).toEqual([JSON.stringify({ type: "echo", text: "mine" })]);
  });

  it("carries a follow on after the object is evicted with its sockets hibernated, from the last cursor", async () => {
    const name = crypto.randomUUID();
    const stub = agent(name);
    await stub.script([{ text: "First." }, { text: "Second." }]);
    const socket = await new TestSocket(() => stub).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    client.follow(sessionId, () => undefined);
    await client.submit(sessionId, { text: "One", requestId: "r-1" });
    await runEnded(socket, sessionId);
    const before = socket.eventsOf(sessionId).length;
    const { cursor } = client.sessionState(sessionId);

    // The object leaves memory; the socket stays connected, its state with it.
    await evictDurableObject(stub);
    // A call over RPC wakes it: nothing on the socket asks it to follow again.
    const reference = await agent(name).submitAndRead(sessionId, "Two", "r-2", cursor!);
    await runEnded(socket, sessionId, 2);
    // From the last cursor the socket had: what a reader from that cursor read meanwhile, no more, no less.
    expect(socket.eventsOf(sessionId, before)).toEqual(reference);
    expect(shape(client.sessionState(sessionId))).toEqual([
      { kind: "user", text: "One" },
      { kind: "assistant", text: "First." },
      { kind: "user", text: "Two" },
      { kind: "assistant", text: "Second." },
    ]);

    // Evicted again, and woken this time by the socket's own call: the queue, compaction and wrap-up state the follow
    // may hold, stated again as a resumed follow is, then the run's events, and nothing of the runs before.
    await stub.script([{ text: "Third." }]);
    const third = socket.eventsOf(sessionId).length;
    await evictDurableObject(agent(name));
    await client.submit(sessionId, { text: "Three", requestId: "r-3" });
    await runEnded(socket, sessionId, 3);
    expect(socket.eventsOf(sessionId, third).map((event) => event.type)).toEqual([
      "queue",
      "compaction:end",
      "wrapup:end",
      "run:start",
      "user",
      "assistant:end",
      "run:end",
    ]);
  });

  it("resumes a follow from its cursor after the object is reset mid-run, which closes the socket", async () => {
    // An object cannot hibernate while its run works; a reset (a crash, a deploy) closes its sockets instead.
    const name = crypto.randomUUID();
    const stub = agent(name);
    await stub.script([{ hold: true }, { text: "Carried on." }]);
    const socket = await new TestSocket(() => agent(name)).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    client.follow(sessionId, () => undefined);
    await client.submit(sessionId, { text: "Work", requestId: "r-1" });
    await eventually(async () => (await stub.requests()) === 1);
    await eventually(async () => socket.eventsOf(sessionId).some((event) => event.type === "user"));
    const before = socket.eventsOf(sessionId).length;

    await abortAllDurableObjects();
    await until(client, sessionId, (state) => state.status === "connecting");
    // The client reconnects, as AgentClient does on its own, while the alarm carries the run on in a new instance.
    await socket.connect();
    const done = await until(client, sessionId, (state) => state.view.status === "idle" && state.view.items.length > 1);
    expect(await agent(name).requests()).toBe(2);
    expect(shape(done)).toEqual([
      { kind: "user", text: "Work" },
      { kind: "assistant", text: "Carried on." },
    ]);
    // Nothing it had folded came again: the message stays one, and the reply comes once.
    const resumed = socket.eventsOf(sessionId, before).map((event) => event.type);
    expect(resumed).not.toContain("user");
    expect(resumed.filter((type) => type === "assistant:end")).toHaveLength(1);
  });
});

describe("a socket client of an object whose scope's lease another writer holds", () => {
  it("is answered lease_held for its calls and its follows, leaving no rejection unhandled", async () => {
    const stub = agent(`held:${crypto.randomUUID()}`);
    await stub.holdLease(true);
    const client = clientOf(await new TestSocket(() => stub).connect());
    const unhandled = await unhandledRejections(async () => {
      await expect(client.createSession()).rejects.toMatchObject({ code: "lease_held" });
      await expect(client.listSessions()).rejects.toMatchObject({ code: "lease_held" });
      client.follow("1", () => undefined);
      expect((await until(client, "1", (state) => state.status === "ended")).error?.code).toBe("lease_held");
    });
    expect(unhandled).toEqual([]);
  });

  it("ends lease_held the follows it reattaches as it starts, leaving no rejection unhandled", async () => {
    const name = `held:${crypto.randomUUID()}`;
    const socket = await new TestSocket(() => agent(name)).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    client.follow(sessionId, () => undefined);
    await until(client, sessionId, (state) => state.status === "live");

    // Another writer takes the scope while the object is out of memory, its socket hibernated with what it follows.
    await agent(name).holdLease(true);
    await evictDurableObject(agent(name));
    const unhandled = await unhandledRejections(async () => {
      // A call that touches nothing of Motoko starts the object, which reattaches the follow and cannot open.
      await agent(name).requests();
      expect((await until(client, sessionId, (state) => state.status === "ended")).error?.code).toBe("lease_held");
    });
    expect(unhandled).toEqual([]);
  });
});

describe("a socket client of a plain Durable Object with WebSockets and Motoko installed", () => {
  it("follows a run, and the app's own frames reach the app", async () => {
    const stub = env.SOCKETS.getByName(crypto.randomUUID());
    await stub.script([{ text: "Plain." }]);
    const socket = await new TestSocket(() => stub).connect();
    const client = clientOf(socket);
    const { id: sessionId } = await client.createSession();
    client.follow(sessionId, () => undefined);
    await client.submit(sessionId, { text: "Hello", requestId: "r-1" });
    const done = await until(
      client,
      sessionId,
      (state) => state.view.status === "idle" && state.view.items.length === 2,
    );
    expect(shape(done)).toEqual([
      { kind: "user", text: "Hello" },
      { kind: "assistant", text: "Plain." },
    ]);

    socket.send(JSON.stringify({ type: "echo", text: "plain" }));
    await eventually(async () => socket.frames.some((frame) => frame.type === "echoed"));
    expect(await stub.seen()).toEqual([JSON.stringify({ type: "echo", text: "plain" })]);
  });

  it("reads the readonly mark off the WebSockets capability", async () => {
    const stub = env.SOCKETS.getByName(crypto.randomUUID());
    await stub.script([{ text: "Plain." }]);
    const writer = clientOf(await new TestSocket(() => stub).connect());
    const { id: sessionId } = await writer.createSession();
    const observer = await new TestSocket(() => stub, "http://motoko.test/?readonly").connect();
    const client = clientOf(observer);
    client.follow(sessionId, () => undefined);
    await until(client, sessionId, (state) => state.status === "live");

    await expect(client.submit(sessionId, { text: "Sneak in", requestId: "r-1" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await writer.submit(sessionId, { text: "Hello", requestId: "r-2" });
    await runEnded(observer, sessionId);
    expect(shape(client.sessionState(sessionId))).toEqual([
      { kind: "user", text: "Hello" },
      { kind: "assistant", text: "Plain." },
    ]);
    expect(await stub.requests()).toBe(1);
  });
});
