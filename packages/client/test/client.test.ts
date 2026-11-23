import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, CallMethod, Cursor } from "@chia1104/motoko-wire";

import { motokoClient, MotokoError } from "../src/index.ts";
import type { FollowListener, MotokoSessionState, MotokoTransport } from "../src/index.ts";

import { uncaughtErrors } from "./uncaught.ts";

/** A call the client made, waiting for the test to settle it. */
interface MadeCall {
  readonly method: CallMethod;
  readonly params: unknown;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: MotokoError) => void;
}

/** A follow the client asked for, which the test drives through its listener. */
interface MadeFollow {
  readonly sessionId: string;
  readonly from: () => Cursor | undefined;
  readonly listener: FollowListener;
  stopped: boolean;
}

/**
 * A transport the test drives: it keeps what the client asks of it, and settles nothing on its own, but for
 * `liveAtOnce`, which confirms each follow as it starts it, before `follow` returns.
 */
class FakeTransport implements MotokoTransport {
  readonly calls: MadeCall[] = [];
  readonly follows: MadeFollow[] = [];
  readonly #liveAtOnce: boolean;

  constructor({ liveAtOnce = false } = {}) {
    this.#liveAtOnce = liveAtOnce;
  }

  call(method: CallMethod, params: unknown, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const closed = () => reject(new MotokoError("connection_closed", "Closed"));
      if (signal.aborted) return closed();
      this.calls.push({ method, params, resolve, reject });
      signal.addEventListener("abort", closed);
    });
  }

  follow(sessionId: string, from: () => Cursor | undefined, listener: FollowListener): () => void {
    const follow: MadeFollow = { sessionId, from, listener, stopped: false };
    this.follows.push(follow);
    if (this.#liveAtOnce) listener.live();
    return () => {
      follow.stopped = true;
    };
  }

  last(method: CallMethod): MadeCall {
    const call = this.calls.findLast((made) => made.method === method);
    if (call === undefined) throw new Error(`No ${method} made`);
    return call;
  }
}

const run: readonly (readonly [Cursor, AgentWireEvent])[] = [
  ["7.0.*" as Cursor, { type: "run:start" }],
  ["7.1.1" as Cursor, { type: "user", messageId: "1", text: "Hi" }],
  ["7.2.1" as Cursor, { type: "assistant:end", messageId: "2", text: "Hello.", stopReason: "stop" }],
  ["7.2.-" as Cursor, { type: "run:end", reason: "done" }],
];

const deliver = (follow: MadeFollow, events: typeof run) => {
  for (const [cursor, event] of events) follow.listener.event({ cursor, event });
};

describe("motokoClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("folds a followed session's events into its view, and tracks the follow's status across a drop", () => {
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    expect(motokoClient(transport)).toBe(client);
    const heard: MotokoSessionState[] = [];
    client.follow("7", (state) => heard.push(state));
    const [follow] = transport.follows;
    expect(follow?.sessionId).toBe("7");
    expect(client.sessionState("7")).toMatchObject({ status: "connecting", view: { items: [] } });

    follow!.listener.live();
    deliver(follow!, run.slice(0, 2));
    follow!.listener.dropped();
    expect(client.sessionState("7").status).toBe("connecting");
    follow!.listener.live();
    deliver(follow!, run.slice(2));

    const state = client.sessionState("7");
    expect(state.view).toEqual(foldEvents(run.map(([, event]) => event)));
    expect(state.cursor).toBe("7.2.-");
    expect(state.status).toBe("live");
    // Unchanged, the same object.
    expect(client.sessionState("7")).toBe(state);
    expect(heard.map((heardState) => heardState.status)).toEqual([
      "live",
      "live",
      "live",
      "connecting",
      "live",
      "live",
      "live",
    ]);
    // A session nobody follows has an empty view.
    expect(client.sessionState("8")).toMatchObject({ status: "connecting", view: { items: [] } });
  });

  it("hands the transport its own cursor, the one right after the last event it folded, to follow on from", () => {
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    client.follow("7", () => undefined);
    const [follow] = transport.follows;
    expect(follow!.from()).toBeUndefined();

    follow!.listener.live();
    deliver(follow!, run.slice(0, 2));
    follow!.listener.dropped();
    expect(follow!.from()).toBe("7.1.1");
    expect(client.sessionState("7").cursor).toBe("7.1.1");
  });

  it("shares one follow among its followers, and keeps it five seconds after the last one leaves", () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    const first = client.follow("7", () => undefined);
    const second = client.follow("7", () => undefined);
    expect(transport.follows).toHaveLength(1);
    const [follow] = transport.follows;
    follow!.listener.live();
    deliver(follow!, run.slice(0, 2));

    first();
    second();
    vi.advanceTimersByTime(4_999);
    deliver(follow!, run.slice(2));
    expect(follow!.stopped).toBe(false);
    expect(client.sessionState("7")).toMatchObject({ status: "live", cursor: "7.2.-" });
    const heard: MotokoSessionState[] = [];
    const back = client.follow("7", (state) => heard.push(state));
    expect(transport.follows).toHaveLength(1);
    follow!.listener.dropped();
    expect(heard).toMatchObject([{ status: "connecting", cursor: "7.2.-" }]);

    back();
    vi.advanceTimersByTime(4_999);
    expect(follow!.stopped).toBe(false);
    vi.advanceTimersByTime(1);
    expect(follow!.stopped).toBe(true);
    expect(client.sessionState("7")).toMatchObject({ status: "connecting", view: { items: [] } });
    expect(client.sessionState("7").cursor).toBeUndefined();
    client.follow("7", () => undefined);
    expect(transport.follows).toHaveLength(2);
    expect(transport.follows[1]!.from()).toBeUndefined();
  });

  it("counts a follower who leaves twice as leaving once", () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    const leave = client.follow("7", () => undefined);
    leave();
    leave();
    client.follow("7", () => undefined);

    vi.advanceTimersByTime(5_000);
    expect(transport.follows).toHaveLength(1);
    expect(transport.follows[0]!.stopped).toBe(false);
  });

  it("takes a leave as only its own follow's, though the listener follows the session again", () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    const heard: MotokoSessionState["status"][] = [];
    const listener = (state: MotokoSessionState) => heard.push(state.status);
    const leave = client.follow("7", listener);
    leave();
    client.follow("7", listener);
    leave();

    transport.follows[0]!.listener.live();
    expect(heard).toEqual(["live"]);
    vi.advanceTimersByTime(5_000);
    expect(transport.follows[0]!.stopped).toBe(false);
  });

  it("follows the session afresh for a later follower when the transport throws as it starts the follow", () => {
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    const refused = new Error("Cannot follow now");
    const follow = transport.follow.bind(transport);
    transport.follow = () => {
      throw refused;
    };
    expect(() => client.follow("7", () => undefined)).toThrow(refused);
    expect(client.sessionState("7")).toMatchObject({ status: "connecting", view: { items: [] } });

    transport.follow = follow;
    const heard: MotokoSessionState["status"][] = [];
    client.follow("7", (state) => heard.push(state.status));
    expect(transport.follows).toHaveLength(1);
    transport.follows[0]!.listener.live();
    expect(heard).toEqual(["live"]);
  });

  it("keeps no follow the server ended once nobody follows it", () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    const leave = client.follow("7", () => undefined);
    const [endedFirst] = transport.follows;
    endedFirst!.listener.ended(new MotokoError("session_not_found", "Gone"));
    leave();
    expect(endedFirst!.stopped).toBe(true);
    expect(client.sessionState("7").status).toBe("connecting");

    client.follow("8", () => undefined)();
    const [, endedWhileKept] = transport.follows;
    expect(endedWhileKept!.stopped).toBe(false);
    endedWhileKept!.listener.ended(new MotokoError("session_not_found", "Gone"));
    expect(endedWhileKept!.stopped).toBe(true);
    expect(client.sessionState("8").status).toBe("connecting");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tells every follower each state though one before it throws, and reports what that one threw", async () => {
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    const heard: MotokoSessionState["status"][] = [];

    const thrown = await uncaughtErrors(() => {
      client.follow("7", (state) => {
        throw new Error(`Not ready for ${state.status}`);
      });
      client.follow("7", (state) => heard.push(state.status));
      const [follow] = transport.follows;
      follow!.listener.live();
      deliver(follow!, run.slice(0, 1));
      follow!.listener.dropped();
      follow!.listener.ended(new MotokoError("session_not_found", "Gone"));
    });

    expect(heard).toEqual(["live", "live", "connecting", "ended"]);
    expect(thrown).toEqual([
      new Error("Not ready for live"),
      new Error("Not ready for live"),
      new Error("Not ready for connecting"),
      new Error("Not ready for ended"),
    ]);
  });

  it("tells the first follower of a session what the transport says as it starts the follow", () => {
    const transport = new FakeTransport({ liveAtOnce: true });
    const client = motokoClient(transport);
    const heard: MotokoSessionState["status"][] = [];
    client.follow("7", (state) => heard.push(state.status));

    expect(heard).toEqual(["live"]);
    expect(client.sessionState("7").status).toBe("live");
  });

  it("stops a follow whose first follower closes the client as the transport starts it", () => {
    const transport = new FakeTransport({ liveAtOnce: true });
    const client = motokoClient(transport);
    client.follow("7", () => client.close());

    expect(transport.follows[0]!.stopped).toBe(true);
    expect(client.sessionState("7").status).toBe("connecting");
  });

  it("keeps a follow the server ended ended, with its error, for every follower of it", () => {
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    client.follow("7", () => undefined);
    const [follow] = transport.follows;
    follow!.listener.live();
    follow!.listener.ended(new MotokoError("session_not_found", "Gone"));

    const later: MotokoSessionState[] = [];
    client.follow("7", (state) => later.push(state));
    expect(transport.follows).toHaveLength(1);
    expect(client.sessionState("7").status).toBe("ended");
    expect(client.sessionState("7").error).toMatchObject({ code: "session_not_found" });
    expect(client.sessionState("7").error).toBeInstanceOf(MotokoError);
  });

  it("sends each call's params as the protocol's, and answers with its parsed result", async () => {
    const transport = new FakeTransport();
    const client = motokoClient(transport);

    const created = client.createSession();
    transport.last("createSession").resolve({ id: "9", createdAt: 5, extra: true });
    expect(await created).toEqual({ id: "9", createdAt: 5 });

    // Each call a fresh request ID of its own, unless the app names one to retry with.
    void client.createSession();
    void client.createSession({ requestId: "c-1" });
    const made = transport.calls.filter((call) => call.method === "createSession");
    const [first, second, named] = made.map(({ params }) => params as { readonly requestId?: unknown });
    expect(first?.requestId).toEqual(expect.any(String));
    expect(second?.requestId).toEqual(expect.any(String));
    expect(second?.requestId).not.toBe(first?.requestId);
    expect(named).toEqual({ requestId: "c-1" });
    for (const call of made.slice(1)) call.resolve({ id: "9", createdAt: 5 });

    const listed = client.listSessions();
    transport.last("listSessions").resolve([{ id: "9", createdAt: 5 }]);
    expect(await listed).toEqual([{ id: "9", createdAt: 5 }]);

    const submitted = client.submit("7", { text: "Go", requestId: "r-1", whenBusy: "reject" });
    expect(transport.last("submit").params).toEqual({
      sessionId: "7",
      text: "Go",
      requestId: "r-1",
      whenBusy: "reject",
    });
    transport.last("submit").resolve({ submissionId: "s-1" });
    expect(await submitted).toEqual({ submissionId: "s-1" });

    const decisions = [{ toolCallId: "t-1", approved: false, comment: "No" }];
    const decided = client.approve("7", decisions);
    expect(transport.last("approve").params).toEqual({ sessionId: "7", decisions });
    transport.last("approve").resolve([{ toolCallId: "t-1", outcome: "applied" }]);
    expect(await decided).toEqual([{ toolCallId: "t-1", outcome: "applied" }]);

    const replyTo = { scope: { kind: "notes", name: "alice" }, sessionId: "3", toolCallId: "q-1", token: "t" };
    const asked = client.submit("7", { text: "Why?", requestId: "r-2", replyTo });
    expect(transport.last("submit").params).toEqual({ sessionId: "7", text: "Why?", requestId: "r-2", replyTo });
    transport.last("submit").resolve({ submissionId: "s-2" });
    expect(await asked).toEqual({ submissionId: "s-2" });

    const replied = client.reply("3", { toolCallId: "q-1", token: "t", text: "Because.", isError: false });
    expect(transport.last("reply").params).toEqual({
      sessionId: "3",
      toolCallId: "q-1",
      token: "t",
      text: "Because.",
      isError: false,
    });
    transport.last("reply").resolve({ outcome: "already_replied" });
    expect(await replied).toEqual({ outcome: "already_replied" });

    const steered = client.submit("7", { text: "This way", requestId: "r-3", whenBusy: "steer" });
    expect(transport.last("submit").params).toEqual({
      sessionId: "7",
      text: "This way",
      requestId: "r-3",
      whenBusy: "steer",
    });
    transport.last("submit").resolve({ submissionId: "s-3" });
    expect(await steered).toEqual({ submissionId: "s-3" });

    const withdrawn = client.withdraw("7", "s-3");
    expect(transport.last("withdraw").params).toEqual({ sessionId: "7", submissionId: "s-3" });
    transport.last("withdraw").resolve({ outcome: "already_placed" });
    expect(await withdrawn).toEqual({ outcome: "already_placed" });

    const aborted = client.abort("7");
    expect(transport.last("abort").params).toEqual({ sessionId: "7" });
    transport.last("abort").resolve(null);
    await expect(aborted).resolves.toBeUndefined();

    const deleted = client.deleteSession("7");
    expect(transport.last("deleteSession").params).toEqual({ sessionId: "7" });
    transport.last("deleteSession").resolve(null);
    await expect(deleted).resolves.toBeUndefined();
  });

  it("rejects with the transport's refusal, and a result that is not the call's as internal", async () => {
    const transport = new FakeTransport();
    const client = motokoClient(transport);

    const busy = client.submit("7", { text: "Go", requestId: "r-1", whenBusy: "reject" });
    transport.last("submit").reject(new MotokoError("session_busy", "Session 7 is busy"));
    const refusal = await busy.catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MotokoError);
    expect(refusal).toMatchObject({ code: "session_busy" });

    const malformed = client.createSession();
    transport.last("createSession").resolve({ id: 9 });
    await expect(malformed).rejects.toMatchObject({ code: "internal" });
  });

  it("rejects what is pending when it is closed, stops its follows, and a later client of the transport starts afresh", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = motokoClient(transport);
    client.follow("7", () => undefined);
    transport.follows[0]!.listener.live();
    client.follow("8", () => undefined)();
    const pending = client.listSessions();

    client.close();
    await expect(pending).rejects.toMatchObject({ code: "connection_closed" });
    expect(transport.follows.map(({ stopped }) => stopped)).toEqual([true, true]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.createSession()).rejects.toMatchObject({ code: "connection_closed" });

    const next = motokoClient(transport);
    expect(next).not.toBe(client);
    expect(next.sessionState("7").status).toBe("connecting");
  });
});
