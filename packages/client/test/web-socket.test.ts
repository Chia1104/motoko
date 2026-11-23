import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent } from "@chia1104/motoko-wire";

import { motokoClient, MotokoError, webSocketTransport } from "../src/index.ts";
import type { MotokoSessionState, MotokoSocket } from "../src/index.ts";

import { FakeSocket } from "./fake-socket.ts";
import { uncaughtErrors } from "./uncaught.ts";

/** The socket's client, as a browser makes it. */
const clientOf = (socket: MotokoSocket) => motokoClient(webSocketTransport(socket));

const run: readonly (readonly [string, AgentWireEvent])[] = [
  ["7.0.*", { type: "run:start" }],
  ["7.1.1", { type: "user", messageId: "1", text: "Hi" }],
  ["7.2.1", { type: "assistant:end", messageId: "2", text: "Hello.", stopReason: "stop" }],
  ["7.2.-", { type: "run:end", reason: "done" }],
];

/** A client on an open fake socket following session 7, its follow confirmed, and the states it heard. */
function following() {
  const socket = new FakeSocket();
  socket.open();
  const client = clientOf(socket);
  const heard: MotokoSessionState[] = [];
  const unfollow = client.follow("7", (state) => heard.push(state));
  socket.reply(socket.last("subscribe"));
  return { socket, client, heard, unfollow };
}

describe("webSocketTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows a session once the socket opens, folding the events that come after the server confirms", () => {
    const socket = new FakeSocket();
    const client = clientOf(socket);
    expect(clientOf(socket)).toBe(client);
    client.follow("7", () => undefined);
    expect(socket.sent).toEqual([]);
    expect(client.sessionState("7").status).toBe("connecting");

    socket.open();
    const subscribe = socket.last("subscribe");
    expect(subscribe).toEqual({
      type: "motoko:call",
      id: expect.any(String),
      method: "subscribe",
      params: { sessionId: "7" },
    });
    // An event before the result is an earlier follow's: dropped.
    socket.event("7", "7.9.-", { type: "user", messageId: "9", text: "Stale" });
    socket.reply(subscribe);
    expect(client.sessionState("7").status).toBe("live");
    for (const [cursor, event] of run) socket.event("7", cursor, event);
    // Another session's events and the app's own frames are not this follow's.
    socket.event("8", "8.1.1", { type: "user", messageId: "1", text: "Elsewhere" });
    socket.receive({ type: "echoed", text: "mine" });
    socket.receive("not json");

    const state = client.sessionState("7");
    expect(state.view).toEqual(foldEvents(run.map(([, event]) => event)));
    expect(state.cursor).toBe("7.2.-");
    expect(client.sessionState("7")).toBe(state);
  });

  it("resumes each follow from its last cursor when the socket reconnects, and fails the calls the close cut off", async () => {
    const { socket, client, heard } = following();
    for (const [cursor, event] of run.slice(0, 2)) socket.event("7", cursor, event);
    const cutOff = client.submit("7", { text: "More", requestId: "r-1" });

    socket.close();
    expect(client.sessionState("7").status).toBe("connecting");
    await expect(cutOff).rejects.toMatchObject({ code: "connection_closed" });
    // Made while closed: sent once the socket opens again.
    const queued = client.listSessions();
    const sentBefore = socket.sent.length;

    socket.open();
    const resent = socket.sent.slice(sentBefore);
    expect(resent.map((call) => [call.method, call.params])).toEqual([
      ["listSessions", {}],
      ["subscribe", { sessionId: "7", from: "7.1.1" }],
    ]);
    socket.reply(socket.last("listSessions"), [{ id: "7", createdAt: 1 }]);
    expect(await queued).toEqual([{ id: "7", createdAt: 1 }]);
    socket.reply(socket.last("subscribe"));
    for (const [cursor, event] of run.slice(2)) socket.event("7", cursor, event);
    expect(client.sessionState("7").view).toEqual(foldEvents(run.map(([, event]) => event)));
    expect(heard.map((state) => state.status)).toEqual(["live", "live", "live", "connecting", "live", "live", "live"]);
  });

  it("follows again on the next connection when a close cuts off its subscribe", () => {
    const socket = new FakeSocket();
    socket.open();
    const client = clientOf(socket);
    client.follow("7", () => undefined);
    const cutOff = socket.last("subscribe");

    socket.close();
    // The reply to the earlier connection's subscribe, were it to come, is not this follow's.
    socket.reply(cutOff);
    expect(client.sessionState("7").status).toBe("connecting");
    socket.open();
    const again = socket.last("subscribe");
    expect(again.id).not.toBe(cutOff.id);
    socket.reply(again);
    expect(client.sessionState("7").status).toBe("live");
  });

  it("drops every follow and fails the calls a close cut off, though a follower throws as it hears the drop", async () => {
    const socket = new FakeSocket();
    socket.open();
    const client = clientOf(socket);
    client.follow("7", (state) => {
      if (state.status === "connecting") throw new Error("Not ready to wait");
    });
    client.follow("8", () => undefined);
    for (const subscribe of socket.sent.filter(({ method }) => method === "subscribe")) socket.reply(subscribe);
    const cutOff = client.listSessions().catch((error: unknown) => error);

    const thrown = await uncaughtErrors(() => socket.close());

    expect(thrown).toEqual([new Error("Not ready to wait")]);
    expect(client.sessionState("8").status).toBe("connecting");
    expect(await cutOff).toMatchObject({ code: "connection_closed" });
  });

  it("answers calls with their typed results, and refusals with their codes", async () => {
    const { socket, client } = following();
    const created = client.createSession();
    socket.reply(socket.last("createSession"), { id: "9", createdAt: 5 });
    expect(await created).toEqual({ id: "9", createdAt: 5 });

    const submitted = client.submit("7", { text: "Go", requestId: "r-1", whenBusy: "reject" });
    expect(socket.last("submit").params).toEqual({ sessionId: "7", text: "Go", requestId: "r-1", whenBusy: "reject" });
    socket.receive({
      type: "motoko:error",
      id: socket.last("submit").id,
      error: { code: "session_busy", message: "Session 7 is busy" },
    });
    const refusal = await submitted.catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MotokoError);
    expect(refusal).toMatchObject({ code: "session_busy" });

    const decided = client.approve("7", [{ toolCallId: "t-1", approved: true }]);
    socket.reply(socket.last("approve"), [{ toolCallId: "t-1", outcome: "applied" }]);
    expect(await decided).toEqual([{ toolCallId: "t-1", outcome: "applied" }]);

    const aborted = client.abort("7");
    socket.reply(socket.last("abort"), { unexpected: true });
    await expect(aborted).rejects.toMatchObject({ code: "internal" });
  });

  it("ends a follow the server ended, and neither follows it again nor unsubscribes it", () => {
    const { socket, client, unfollow } = following();
    socket.receive({ type: "motoko:ended", sessionId: "7", error: { code: "session_not_found", message: "gone" } });
    const state = client.sessionState("7");
    expect(state.status).toBe("ended");
    expect(state.error).toMatchObject({ code: "session_not_found" });

    socket.close();
    socket.open();
    unfollow();
    expect(socket.sent.map((call) => call.method)).toEqual(["subscribe"]);
  });

  it("shares one follow among its followers, and unsubscribes it five seconds after the last one leaves", () => {
    vi.useFakeTimers();
    const { socket, client, unfollow } = following();
    const second = client.follow("7", () => undefined);
    expect(socket.sent.filter((call) => call.method === "subscribe")).toHaveLength(1);

    unfollow();
    second();
    vi.advanceTimersByTime(4_999);
    expect(socket.sent.some((call) => call.method === "unsubscribe")).toBe(false);
    expect(client.sessionState("7").status).toBe("live");
    vi.advanceTimersByTime(1);
    expect(socket.last("unsubscribe").params).toEqual({ sessionId: "7" });
    expect(client.sessionState("7").status).toBe("connecting");
  });

  it("rejects what is pending when it is closed, and a later client of the socket starts afresh", async () => {
    const { socket, client } = following();
    const pending = client.listSessions();
    client.close();
    await expect(pending).rejects.toMatchObject({ code: "connection_closed" });
    expect(clientOf(socket)).not.toBe(client);
    expect(clientOf(socket).sessionState("7").status).toBe("connecting");
  });

  it("never sends a call queued while the socket was closed once its client closes, nor its follows", async () => {
    const socket = new FakeSocket();
    const client = clientOf(socket);
    const queued = client.submit("7", { text: "Go", requestId: "r-1" });
    client.follow("7", () => undefined);

    client.close();
    await expect(queued).rejects.toMatchObject({ code: "connection_closed" });
    socket.open();
    expect(socket.sent).toEqual([]);
  });
});
