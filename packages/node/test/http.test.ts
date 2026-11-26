import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool, inProcessLeases } from "@chia1104/motoko-core";
import type { AgentRuntime } from "@chia1104/motoko-core";
import { encodeCursor, followedEventSchema, followEndedSchema } from "@chia1104/motoko-wire";
import type { AgentWireEvent } from "@chia1104/motoko-wire";

import { motokoHandler, nodeHost, nodeListener, sqliteStorage } from "../src/index.ts";
import type { HttpCall, MotokoHandlerOptions, MotokoTarget } from "../src/index.ts";

import { eventually, follow, has } from "./helpers.ts";

const send = defineTool({
  name: "send",
  description: "Send a message",
  tier: "external",
  parameters: z.object({ to: z.string() }),
  async execute({ to }) {
    return { text: `sent to ${to}` };
  },
});
const agent = defineAgent({
  kind: "chat",
  instructions: "Chat.",
  tools: [send],
  policy: { requiresApproval: ["external"] },
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const defaultModel = { provider: faux.provider.id, modelId: faux.getModel().id };

let directory: string;
let reported: unknown[];
const runtimes: AgentRuntime[] = [];
const servers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-runtime-http-"));
  reported = [];
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await rm(directory, { recursive: true, force: true });
});

function runtimeOf(options: { closeIdleAfterMs?: number; leases?: ReturnType<typeof inProcessLeases> } = {}) {
  const runtime = createAgentRuntime({
    agents: [agent],
    host: nodeHost({
      storage: sqliteStorage({ directory }),
      ...(options.leases !== undefined && { lease: options.leases }),
    }),
    models,
    ports: {},
    defaultModel,
    ...(options.closeIdleAfterMs !== undefined && { closeIdleAfterMs: options.closeIdleAfterMs }),
  });
  runtimes.push(runtime);
  return runtime;
}

function handlerOf(runtime: AgentRuntime, options: Partial<MotokoHandlerOptions<MotokoTarget>> = {}) {
  return motokoHandler(runtime, {
    basePath: "/motoko",
    resolve: () => ({ agent, name: "a" }),
    onError: (error) => reported.push(error),
    ...options,
  });
}

type Handler = ReturnType<typeof handlerOf>;

async function call(handler: Handler, method: string, params: unknown = {}) {
  const response = await handler(
    new Request("http://app.test/motoko/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createSession(handler: Handler): Promise<string> {
  const { body } = await call(handler, "createSession");
  return (body.result as { id: string }).id;
}

async function listen(handler: Handler): Promise<string> {
  const server = createServer(nodeListener(handler));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/motoko`;
}

interface Frame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
}

async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const frame: Record<string, string> = {};
      for (const line of buffer.slice(0, end).split("\n")) {
        const colon = line.indexOf(":");
        const field = line.slice(0, colon);
        frame[field === "" ? "comment" : field] = line.slice(colon + 1).replace(/^ /, "");
      }
      buffer = buffer.slice(end + 2);
      yield frame;
    }
  }
}

async function openFollow(base: string, sessionId: string, options: { lastEventId?: string; from?: string } = {}) {
  const url = new URL(`${base}/sessions/${sessionId}/events`);
  if (options.from !== undefined) url.searchParams.set("from", options.from);
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: options.lastEventId === undefined ? {} : { "last-event-id": options.lastEventId },
    signal: controller.signal,
  });
  const frames = response.body === null ? undefined : framesOf(response.body);
  return { response, frames: frames!, disconnect: () => controller.abort() };
}

interface Received {
  readonly id: string | undefined;
  readonly cursor: string;
  readonly event: AgentWireEvent;
}

async function readUntil(frames: AsyncGenerator<Frame>, until: (event: AgentWireEvent) => boolean) {
  const received: Received[] = [];
  for (;;) {
    const { done, value } = await frames.next();
    if (done === true) throw new Error(`The stream ended after ${received.map(({ event }) => event.type).join(", ")}`);
    if (value.comment !== undefined) continue;
    if (value.event !== undefined) throw new Error(`Unexpected ${value.event}: ${value.data}`);
    const { cursor, event } = followedEventSchema.parse(JSON.parse(value.data ?? ""));
    received.push({ id: value.id, cursor, event });
    if (until(event)) return received;
  }
}

const isRunEnd = (event: AgentWireEvent) => event.type === "run:end";
const readersOf = (runtime: AgentRuntime) => runtime.inspect().instances.reduce((sum, { readers }) => sum + readers, 0);
const items = (received: readonly Received[]) => received.map(({ cursor, event }) => ({ cursor, event }));

function gatedReply(text: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage(text);
    },
  ]);
  return release;
}

describe("calls", () => {
  it("answers each call with its result", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime);
    const created = await call(handler, "createSession");
    expect(created).toEqual({
      status: 200,
      body: { result: { id: expect.any(String), createdAt: expect.any(Number) } },
    });
    const { id } = created.body.result as { id: string };
    expect(await call(handler, "listSessions")).toEqual({ status: 200, body: { result: [created.body.result] } });

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("send", { to: "bob" }, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Sent."),
    ]);
    const reader = follow(runtime.get(agent, "a").session(id));
    expect(await call(handler, "submit", { sessionId: id, text: "Tell Bob", requestId: "r1" })).toEqual({
      status: 200,
      body: { result: { submissionId: expect.any(String) } },
    });
    await eventually(() => has(reader.items, "approval:request"));
    expect(
      await call(handler, "approve", { sessionId: id, decisions: [{ toolCallId: "call-1", approved: true }] }),
    ).toEqual({ status: 200, body: { result: [{ toolCallId: "call-1", outcome: "applied" }] } });
    await eventually(() => has(reader.items, "run:end"));
    await reader.stop();

    expect(await call(handler, "abort", { sessionId: id })).toEqual({ status: 200, body: { result: null } });
    expect(await call(handler, "deleteSession", { sessionId: id })).toEqual({ status: 200, body: { result: null } });
    expect(await call(handler, "listSessions")).toEqual({ status: 200, body: { result: [] } });
  });

  it("refuses a request that is not a call", async () => {
    const handler = handlerOf(runtimeOf());
    const post = (path: string, body: string, type = "application/json") =>
      handler(new Request(`http://app.test${path}`, { method: "POST", headers: { "content-type": type }, body }));
    const refusal = async (response: Response) => ({
      status: response.status,
      code: ((await response.json()) as { error: { code: string } }).error.code,
    });

    expect(await refusal(await post("/motoko/call", "{"))).toEqual({ status: 400, code: "invalid_request" });
    expect(await refusal(await post("/motoko/call", `{"method":"nope","params":{}}`))).toEqual({
      status: 400,
      code: "invalid_request",
    });
    const missing = await call(handler, "submit", { sessionId: "1", text: "x" });
    expect(missing).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await refusal(await post("/motoko/call", "{}", "text/plain"))).toEqual({
      status: 415,
      code: "invalid_request",
    });
    expect(await refusal(await post("/elsewhere/call", "{}"))).toEqual({ status: 404, code: "invalid_request" });
    const get = await handler(new Request("http://app.test/motoko/call"));
    expect(get.headers.get("allow")).toBe("POST");
    expect(await refusal(get)).toEqual({ status: 405, code: "invalid_request" });
  });

  it("answers the runtime's errors with their codes and statuses", async () => {
    const leases = inProcessLeases();
    const runtime = runtimeOf({ leases });
    const handler = handlerOf(runtime);
    const id = await createSession(handler);

    expect(await call(handler, "submit", { sessionId: "999", text: "x", requestId: "x" })).toMatchObject({
      status: 404,
      body: { error: { code: "session_not_found" } },
    });
    expect(
      await call(handler, "approve", { sessionId: id, decisions: [{ toolCallId: "nobody", approved: true }] }),
    ).toMatchObject({ status: 409, body: { error: { code: "approval_not_pending" } } });

    const release = gatedReply("Done.");
    await call(handler, "submit", { sessionId: id, text: "Go", requestId: "r1" });
    expect(
      await call(handler, "submit", { sessionId: id, text: "Again", requestId: "r2", whenBusy: "reject" }),
    ).toMatchObject({ status: 409, body: { error: { code: "session_busy" } } });
    release();

    const other = handlerOf(runtimeOf({ leases }));
    expect(await call(other, "listSessions")).toMatchObject({ status: 503, body: { error: { code: "lease_held" } } });
    const follow = await other(new Request(`http://app.test/motoko/sessions/${id}/events`));
    expect(follow.status).toBe(503);
    expect(await follow.json()).toMatchObject({ error: { code: "lease_held" } });
    expect(reported).toEqual([]);
  });

  it("refuses a cluster whose self is not an http(s) URL, or whose connect timeout is not positive", () => {
    const runtime = runtimeOf();
    expect(() => handlerOf(runtime, { cluster: { self: "worker-7:4242", peers: [] } })).toThrow(TypeError);
    expect(() =>
      handlerOf(runtime, { cluster: { self: "http://10.0.0.7:3000/motoko", peers: [], connectTimeoutMs: 0 } }),
    ).toThrow(TypeError);
  });

  it("answers an error that is not the runtime's as internal, with no detail, and reports it", async () => {
    const runtime = createAgentRuntime({
      agents: [agent],
      host: nodeHost({ storage: sqliteStorage({ directory }) }),
      models,
      ports: {},
    });
    runtimes.push(runtime);
    const handler = handlerOf(runtime);

    expect(await call(handler, "createSession")).toEqual({
      status: 500,
      body: { error: { code: "internal", message: "Internal error" } },
    });
    expect(reported).toEqual([expect.any(TypeError)]);

    const failing = handlerOf(runtime, {
      resolve: () => {
        throw new Error("the session store is down");
      },
    });
    expect(await call(failing, "listSessions")).toEqual({
      status: 500,
      body: { error: { code: "internal", message: "Internal error" } },
    });
    expect(reported.at(-1)).toEqual(new Error("the session store is down"));
  });

  it("sends the Response resolve refuses with as it is, and runs nothing", async () => {
    const runtime = runtimeOf();
    const refused = handlerOf(runtime, { resolve: () => new Response("Sign in first", { status: 401 }) });
    const response = await refused(
      new Request("http://app.test/motoko/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "createSession", params: {} }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Sign in first");
    expect(await runtime.get(agent, "a").listSessions()).toEqual([]);
  });
});

describe("a call's body", () => {
  const json = { "content-type": "application/json" };
  const listSessions = JSON.stringify({ method: "listSessions", params: {} });
  const codeOf = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

  it("is refused with 413 once it streams past maxBodyBytes, and the rest is cancelled unread", async () => {
    const handler = handlerOf(runtimeOf(), { maxBodyBytes: 1024 });
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 100;
        controller.enqueue(new TextEncoder().encode(" ".repeat(100)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handler(
      new Request("http://app.test/motoko/call", { method: "POST", headers: json, body, duplex: "half" }),
    );

    expect(response.status).toBe(413);
    expect(await codeOf(response)).toBe("invalid_request");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(1024 + 300);
  });

  it("is taken up to 1 MiB by default, and refused one byte past it", async () => {
    const handler = handlerOf(runtimeOf());
    const post = (length: number) =>
      handler(
        new Request("http://app.test/motoko/call", {
          method: "POST",
          headers: json,
          body: listSessions.padEnd(length, " "),
        }),
      );

    const atCap = await post(1024 * 1024);
    expect(atCap.status).toBe(200);
    expect(await atCap.json()).toEqual({ result: [] });
    const past = await post(1024 * 1024 + 1);
    expect(past.status).toBe(413);
    expect(await codeOf(past)).toBe("invalid_request");
  });

  it("is refused with 413, unread, when the length it declares is past maxBodyBytes", async () => {
    const handler = handlerOf(runtimeOf(), { maxBodyBytes: 1024 });
    const response = await handler(
      new Request("http://app.test/motoko/call", {
        method: "POST",
        headers: { ...json, "content-length": "1025" },
        body: listSessions,
      }),
    );

    expect(response.status).toBe(413);
    expect(await codeOf(response)).toBe("invalid_request");
  });

  it("is answered 413 over Node's http while the client still sends, declared too long or not", async () => {
    const base = await listen(handlerOf(runtimeOf(), { maxBodyBytes: 1024 }));
    const send = (headers: Record<string, string>) =>
      new Promise<{ status: number; code: string; sent: number }>((resolve, reject) => {
        const request = httpRequest(`${base}/call`, { method: "POST", headers: { ...json, ...headers } });
        const chunk = Buffer.alloc(64 * 1024, " ");
        let sent = 0;
        let answered = false;
        const write = () => {
          while (!answered && sent < 64 * 1024 * 1024) {
            sent += chunk.length;
            if (!request.write(chunk)) {
              request.once("drain", write);
              return;
            }
          }
        };
        request.on("response", (response) => {
          answered = true;
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (data: string) => (text += data));
          response.on("end", () => {
            request.destroy();
            resolve({
              status: response.statusCode!,
              code: (JSON.parse(text) as { error: { code: string } }).error.code,
              sent,
            });
          });
        });
        request.on("error", reject);
        write();
      });

    const streamed = await send({});
    expect(streamed).toMatchObject({ status: 413, code: "invalid_request" });
    expect(streamed.sent).toBeLessThan(64 * 1024 * 1024);
    expect(await send({ "content-length": String(64 * 1024 * 1024) })).toMatchObject({
      status: 413,
      code: "invalid_request",
    });
  });
});

describe("authorize", () => {
  it("refuses a call with 403, and nothing of it runs", async () => {
    const runtime = runtimeOf();
    const decided: HttpCall[] = [];
    const handler = handlerOf(runtime, {
      authorize: (_request, call) => {
        decided.push(call);
        return call.method !== "createSession";
      },
    });

    expect(await call(handler, "createSession")).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(await call(handler, "listSessions")).toEqual({ status: 200, body: { result: [] } });
    expect(decided).toEqual([
      { method: "createSession", params: {} },
      { method: "listSessions", params: {} },
    ]);
    expect(await runtime.get(agent, "a").listSessions()).toEqual([]);
  });

  it("decides a follow, which it tells from a call, and refuses it with 403", async () => {
    const runtime = runtimeOf();
    const id = await createSession(handlerOf(runtime));
    const decided: HttpCall[] = [];
    const handler = handlerOf(runtime, {
      authorize: (_request, call) => {
        decided.push(call);
        return call.method !== "follow";
      },
    });
    const from = encodeCursor({ session: id, entry: 0 });

    const response = await handler(new Request(`http://app.test/motoko/sessions/${id}/events?from=${from}`));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(decided).toEqual([{ method: "follow", params: { sessionId: id, from } }]);
  });
});

describe("following a session over SSE", () => {
  it("streams a run's events in order, each with its cursor as its id", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime);
    const base = await listen(handler);
    const id = await createSession(handler);
    const direct = follow(runtime.get(agent, "a").session(id));
    const sse = await openFollow(base, id);
    expect(sse.response.status).toBe(200);
    expect(sse.response.headers.get("content-type")).toBe("text/event-stream");
    await eventually(() => readersOf(runtime) === 2);

    faux.setResponses([fauxAssistantMessage("Hello there, and welcome.")]);
    await call(handler, "submit", { sessionId: id, text: "Hi", requestId: "r1" });
    const received = await readUntil(sse.frames, isRunEnd);
    await eventually(() => has(direct.items, "run:end"));
    await direct.stop();

    expect(received.map(({ event }) => event.type)).toEqual(expect.arrayContaining(["user", "assistant:end"]));
    expect(received.map(({ id: eventId }) => eventId)).toEqual(received.map(({ cursor }) => cursor));
    expect(items(received)).toEqual(direct.items);
  });

  it("resumes a reconnect after Last-Event-ID with exactly the events it missed", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime);
    const base = await listen(handler);
    const id = await createSession(handler);
    const stayed = await openFollow(base, id);
    const first = await openFollow(base, id);
    await eventually(() => readersOf(runtime) === 2);

    const release = gatedReply("Here is the whole answer, at last.");
    await call(handler, "submit", { sessionId: id, text: "Go", requestId: "r1" });
    const before = await readUntil(first.frames, (event) => event.type === "user");
    first.disconnect();
    await eventually(() => readersOf(runtime) === 1);
    release();
    const all = await readUntil(stayed.frames, isRunEnd);

    const resumed = await openFollow(base, id, { lastEventId: before.at(-1)!.id! });
    const after = await readUntil(resumed.frames, isRunEnd);
    expect(after.map(({ event }) => event.type)).toContain("assistant:end");
    expect(items([...before, ...after])).toEqual(items(all));
  });

  it("takes the cursor from the query, and Last-Event-ID over it when a client sends both", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime);
    const base = await listen(handler);
    const id = await createSession(handler);
    const stayed = await openFollow(base, id);
    await eventually(() => readersOf(runtime) === 1);
    faux.setResponses([fauxAssistantMessage("One answer.")]);
    await call(handler, "submit", { sessionId: id, text: "Go", requestId: "r1" });
    const all = await readUntil(stayed.frames, isRunEnd);
    const cut = 1;

    const fromQuery = await openFollow(base, id, { from: all[cut]!.cursor });
    expect(items(await readUntil(fromQuery.frames, isRunEnd))).toEqual(items(all.slice(cut + 1)));
    // EventSource reconnects to the URL it opened, with the newer cursor in Last-Event-ID.
    const both = await openFollow(base, id, { from: all[0]!.cursor, lastEventId: all[cut]!.cursor });
    expect(items(await readUntil(both.frames, isRunEnd))).toEqual(items(all.slice(cut + 1)));
  });

  it("refuses a cursor that is not one of the session's, or a session that does not exist, before streaming", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime);
    const base = await listen(handler);
    const id = await createSession(handler);
    const otherId = await createSession(handler);
    const refusal = async (opened: Awaited<ReturnType<typeof openFollow>>) => ({
      status: opened.response.status,
      type: opened.response.headers.get("content-type"),
      body: (await opened.response.json()) as unknown,
    });
    const invalidCursor = {
      status: 400,
      type: "application/json",
      body: { error: { code: "invalid_cursor", message: expect.any(String) } },
    };

    expect(await refusal(await openFollow(base, id, { from: "nonsense" }))).toEqual(invalidCursor);
    expect(await refusal(await openFollow(base, id, { lastEventId: "nonsense" }))).toEqual(invalidCursor);
    const ofAnother = encodeCursor({ session: otherId, entry: 0 });
    expect(await refusal(await openFollow(base, id, { from: ofAnother }))).toEqual(invalidCursor);
    expect(await refusal(await openFollow(base, "999"))).toMatchObject({
      status: 404,
      body: { error: { code: "session_not_found" } },
    });
    expect(readersOf(runtime)).toBe(0);
  });

  it("ends the follow of a deleted session with an ended event, and closes the stream", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime);
    const base = await listen(handler);
    const id = await createSession(handler);
    const sse = await openFollow(base, id);
    await eventually(() => readersOf(runtime) === 1);

    await call(handler, "deleteSession", { sessionId: id });
    const { value } = await sse.frames.next();
    expect(value?.event).toBe("ended");
    expect(followEndedSchema.parse(JSON.parse(value?.data ?? ""))).toEqual({
      sessionId: id,
      error: { code: "session_not_found", message: expect.any(String) },
    });
    expect(await sse.frames.next()).toEqual({ done: true, value: undefined });
  });

  it("ends the stream without an ended event when the instance closes, so the client reconnects and resumes", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime);
    const base = await listen(handler);
    const id = await createSession(handler);
    const sse = await openFollow(base, id);
    faux.setResponses([fauxAssistantMessage("First."), fauxAssistantMessage("Second.")]);
    await call(handler, "submit", { sessionId: id, text: "One", requestId: "r1" });
    const first = await readUntil(sse.frames, isRunEnd);

    await runtime.get(agent, "a").close();
    expect(await sse.frames.next()).toEqual({ done: true, value: undefined });

    const resumed = await openFollow(base, id, { lastEventId: first.at(-1)!.id! });
    expect(resumed.response.status).toBe(200);
    await call(handler, "submit", { sessionId: id, text: "Two", requestId: "r2" });
    const second = await readUntil(resumed.frames, isRunEnd);
    expect(second.filter(({ event }) => event.type === "user").map(({ event }) => event)).toEqual([
      expect.objectContaining({ text: "Two" }),
    ]);
    expect(reported).toEqual([]);
  });

  it("ends every stream quietly when the runtime closes", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime);
    const base = await listen(handler);
    const id = await createSession(handler);
    const sse = await openFollow(base, id);
    await eventually(() => readersOf(runtime) === 1);

    await runtime.close();
    expect(await sse.frames.next()).toEqual({ done: true, value: undefined });
    expect(reported).toEqual([]);
  });

  it("sends a heartbeat comment while there is nothing to send", async () => {
    const runtime = runtimeOf();
    const handler = handlerOf(runtime, { heartbeatMs: 20 });
    const base = await listen(handler);
    const id = await createSession(handler);
    const sse = await openFollow(base, id);

    expect((await sse.frames.next()).value).toEqual({ comment: "heartbeat" });
    expect((await sse.frames.next()).value).toEqual({ comment: "heartbeat" });
  });

  it("stops the reader when the client goes away, so the instance closes once idle", async () => {
    const runtime = runtimeOf({ closeIdleAfterMs: 50 });
    const instance = runtime.get(agent, "a");
    const handler = handlerOf(runtime);
    const base = await listen(handler);
    const id = await createSession(handler);
    const sse = await openFollow(base, id);
    await eventually(() => readersOf(runtime) === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(instance.state).toBe("open");

    sse.disconnect();
    await eventually(() => instance.state === "dormant", 2_000);
    expect(readersOf(runtime)).toBe(0);
  });
});
