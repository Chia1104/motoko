import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "@chia1104/motoko-core";
import type { AgentRuntime, AgentSession } from "@chia1104/motoko-core";
import { motokoHandler, nodeHost, nodeListener, sqliteStorage } from "@chia1104/motoko-node";
import type { MotokoHandlerOptions, MotokoTarget } from "@chia1104/motoko-node";
import { encodeCursor, foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

import { httpTransport, motokoClient, MotokoError } from "../src/index.ts";
import type { HttpTransportOptions, MotokoClient, MotokoSessionState, MotokoTransport } from "../src/index.ts";

import { uncaughtErrors } from "./uncaught.ts";

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
const runtimes: AgentRuntime[] = [];
const servers: (() => Promise<void>)[] = [];
const stops: (() => void)[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "motoko-client-http-"));
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await Promise.all(servers.splice(0).map((close) => close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await rm(directory, { recursive: true, force: true });
});

function runtimeOf(): AgentRuntime {
  const runtime = createAgentRuntime({
    agents: [agent],
    host: nodeHost({ storage: sqliteStorage({ directory }) }),
    models,
    ports: {},
    defaultModel,
  });
  runtimes.push(runtime);
  return runtime;
}

async function serve(runtime: AgentRuntime, options: Partial<MotokoHandlerOptions<MotokoTarget>> = {}) {
  const handler = motokoHandler(runtime, { basePath: "/motoko", resolve: () => ({ agent, name: "a" }), ...options });
  const server = createServer(nodeListener(handler));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/motoko`,
    cut: () => server.closeAllConnections(),
  };
}

interface Sent {
  readonly url: string;
  readonly headers: Headers;
}

function gatedFetch() {
  const requests: Sent[] = [];
  let opened = Promise.resolve();
  let open: () => void = () => undefined;
  return {
    requests,
    follows: () => requests.filter((request) => request.url.endsWith("/events")),
    fetch: async (input: string, init: RequestInit) => {
      requests.push({ url: input, headers: new Headers(init.headers) });
      await opened;
      return fetch(input, init);
    },
    shut() {
      opened = new Promise((resolve) => (open = resolve));
    },
    open: () => open(),
  };
}

function recording(transport: MotokoTransport) {
  const events: StreamItem[] = [];
  const recorder: MotokoTransport = {
    call: transport.call.bind(transport),
    follow: (sessionId, from, listener) =>
      transport.follow(sessionId, from, {
        ...listener,
        event: (item) => {
          events.push(item);
          listener.event(item);
        },
      }),
  };
  return { events, transport: recorder };
}

function clientOf(transport: MotokoTransport): MotokoClient {
  const client = motokoClient(transport);
  stops.push(() => client.close());
  return client;
}

function reader(session: AgentSession) {
  const controller = new AbortController();
  const items: StreamItem[] = [];
  void (async () => {
    for await (const item of session.events({ signal: controller.signal })) items.push(item);
  })();
  stops.push(() => controller.abort());
  return { items };
}

async function eventually(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (items: readonly StreamItem[], type: AgentWireEvent["type"]) =>
  items.some(({ event }) => event.type === type);
const readersOf = (runtime: AgentRuntime) => runtime.inspect().instances.reduce((sum, { readers }) => sum + readers, 0);
const status = (client: MotokoClient, sessionId: string) => client.sessionState(sessionId).status;
const events = (items: readonly StreamItem[]) => items.map(({ event }) => event);

const PAST_FIRST_RETRY_MS = 700;

describe("httpTransport against motokoHandler", () => {
  it("follows a session and makes its calls: the run's events arrive in order, folded into the view", async () => {
    const runtime = runtimeOf();
    const { baseUrl } = await serve(runtime);
    const { events: delivered, transport } = recording(httpTransport({ baseUrl }));
    const client = clientOf(transport);
    const { id } = await client.createSession();
    expect(await client.listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
    const stayed = reader(runtime.get(agent, "a").session(id));
    client.follow(id, () => undefined);
    await eventually(() => status(client, id) === "live" && readersOf(runtime) === 2);

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("send", { to: "bob" }, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Sent."),
    ]);
    const { submissionId } = await client.submit(id, { text: "Tell Bob", requestId: "r-1" });
    expect(await client.submit(id, { text: "Tell Bob", requestId: "r-1" })).toEqual({ submissionId });
    await eventually(() => client.sessionState(id).view.status === "awaiting_approval");
    expect(client.sessionState(id).view.pendingApprovals).toEqual(["call-1"]);
    expect(await client.approve(id, [{ toolCallId: "call-1", approved: true }])).toEqual([
      { toolCallId: "call-1", outcome: "applied" },
    ]);
    await eventually(() => has(delivered, "run:end") && has(stayed.items, "run:end"));

    expect(delivered).toEqual(stayed.items);
    const state = client.sessionState(id);
    expect(state.view).toEqual(foldEvents(events(stayed.items)));
    expect(state.cursor).toBe(stayed.items.at(-1)!.cursor);
    expect(state.view.items.at(-1)).toMatchObject({ kind: "assistant", text: "Sent." });
    await expect(client.submit("999", { text: "Nobody", requestId: "r-2" })).rejects.toMatchObject({
      code: "session_not_found",
    });
  });

  it("makes one session when a createSession whose reply was lost is made again with its request ID", async () => {
    const runtime = runtimeOf();
    const { baseUrl } = await serve(runtime);
    let lose = true;
    const client = clientOf(
      httpTransport({
        baseUrl,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (!lose) return response;
          lose = false;
          await response.text();
          throw new TypeError("The connection reset");
        },
      }),
    );

    await expect(client.createSession({ requestId: "c-1" })).rejects.toMatchObject({ code: "connection_closed" });
    const created = await client.createSession({ requestId: "c-1" });
    expect(await client.listSessions()).toEqual([created]);
    const other = await client.createSession();
    expect(other.id).not.toBe(created.id);
  });

  it("resumes a follow the server cut mid-run from the client's cursor, with exactly the events it missed", async () => {
    const runtime = runtimeOf();
    const { baseUrl, cut } = await serve(runtime);
    const gated = gatedFetch();
    const { events: delivered, transport } = recording(httpTransport({ baseUrl, fetch: gated.fetch }));
    const client = clientOf(transport);
    const { id } = await client.createSession();
    const stayed = reader(runtime.get(agent, "a").session(id));
    client.follow(id, () => undefined);
    await eventually(() => status(client, id) === "live" && readersOf(runtime) === 2);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("Here is the whole answer, at last.");
      },
    ]);
    await client.submit(id, { text: "Go", requestId: "r-1" });
    await eventually(() => has(delivered, "user"));

    gated.shut();
    cut();
    await eventually(() => status(client, id) === "connecting");
    const before = delivered.length;
    await eventually(() => gated.follows().length === 2);
    release();
    await eventually(() => has(stayed.items, "run:end"));
    expect(delivered).toHaveLength(before);

    gated.open();
    await eventually(() => has(delivered, "run:end"));
    expect(gated.follows()[1]!.headers.get("last-event-id")).toBe(delivered[before - 1]!.cursor);
    expect(events(delivered.slice(before)).map(({ type }) => type)).toContain("assistant:end");
    expect(delivered).toEqual(stayed.items);
    expect(client.sessionState(id)).toMatchObject({ status: "live", view: foldEvents(events(stayed.items)) });
  });

  it("sends its headers with every request, asking a function of them again for each", async () => {
    const runtime = runtimeOf();
    const seen: (string | null)[] = [];
    const { baseUrl } = await serve(runtime, {
      resolve: (request) => {
        const authorization = request.headers.get("authorization");
        seen.push(authorization);
        return authorization === null ? new Response("Sign in first", { status: 401 }) : { agent, name: "a" };
      },
    });
    let token = "t-1";
    const client = clientOf(httpTransport({ baseUrl, headers: () => ({ authorization: `Bearer ${token}` }) }));
    const { id } = await client.createSession();
    token = "t-2";
    client.follow(id, () => undefined);
    await eventually(() => status(client, id) === "live");
    expect(seen).toEqual(["Bearer t-1", "Bearer t-2"]);

    const fixed = clientOf(httpTransport({ baseUrl, headers: { authorization: "Bearer fixed" } }));
    expect(await fixed.listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
    expect(seen.at(-1)).toBe("Bearer fixed");

    const anonymous = clientOf(httpTransport({ baseUrl }));
    await expect(anonymous.listSessions()).rejects.toMatchObject({ code: "forbidden" });
    anonymous.follow(id, () => undefined);
    await eventually(() => status(anonymous, id) === "ended");
    expect(anonymous.sessionState(id).error).toMatchObject({ code: "forbidden" });
  });

  it("ends a follow the server refuses before streaming with the refusal's code, and does not try it again", async () => {
    const runtime = runtimeOf();
    const { baseUrl } = await serve(runtime, { authorize: (_request, call) => call.method !== "follow" });
    const gated = gatedFetch();
    const client = clientOf(httpTransport({ baseUrl, fetch: gated.fetch }));
    const { id } = await client.createSession();
    const { id: otherId } = await client.createSession();

    client.follow(id, () => undefined);
    await eventually(() => status(client, id) === "ended");
    expect(client.sessionState(id).error).toBeInstanceOf(MotokoError);
    expect(client.sessionState(id).error).toMatchObject({ code: "forbidden" });

    const { baseUrl: open } = await serve(runtime);
    const refused = gatedFetch();
    const ended: MotokoError[] = [];
    const listener = { live: () => undefined, event: () => undefined, dropped: () => undefined };
    stops.push(
      httpTransport({ baseUrl: open, fetch: refused.fetch }).follow(
        id,
        () => encodeCursor({ session: otherId, entry: 0 }),
        { ...listener, ended: (error) => ended.push(error) },
      ),
    );
    await eventually(() => ended.length === 1);
    expect(ended[0]).toMatchObject({ code: "invalid_cursor" });

    await pause(PAST_FIRST_RETRY_MS);
    expect(gated.follows()).toHaveLength(1);
    expect(refused.follows()).toHaveLength(1);
    expect(ended).toHaveLength(1);
  });

  it("ends the follow of a session deleted while it is followed, and does not follow it again", async () => {
    const runtime = runtimeOf();
    const { baseUrl } = await serve(runtime);
    const gated = gatedFetch();
    const client = clientOf(httpTransport({ baseUrl, fetch: gated.fetch }));
    const { id } = await client.createSession();
    client.follow(id, () => undefined);
    await eventually(() => status(client, id) === "live" && readersOf(runtime) === 1);

    await client.deleteSession(id);
    await eventually(() => status(client, id) === "ended");
    expect(client.sessionState(id).error).toMatchObject({ code: "session_not_found" });
    await pause(PAST_FIRST_RETRY_MS);
    expect(gated.follows()).toHaveLength(1);
  });
});

describe("httpTransport's event stream", () => {
  const encoder = new TextEncoder();

  function scripted(...bodies: (readonly Uint8Array[] | Error | Response)[]) {
    const requests: Sent[] = [];
    const fetch: HttpTransportOptions["fetch"] = async (input, init) => {
      requests.push({ url: input, headers: new Headers(init.headers) });
      const body = bodies[Math.min(requests.length, bodies.length) - 1]!;
      if (body instanceof Error) throw body;
      if (body instanceof Response) return body;
      const last = requests.length >= bodies.length;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of body) controller.enqueue(chunk);
          if (!last) controller.close();
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    };
    return { requests, fetch };
  }

  const frame = (cursor: string, event: AgentWireEvent) => JSON.stringify({ sessionId: "7", cursor, event });
  const user: AgentWireEvent = { type: "user", messageId: "1", text: "Héllo" };
  const reply: AgentWireEvent = { type: "assistant:end", messageId: "2", text: "Hi.", stopReason: "stop" };

  it("reads messages as the SSE spec does, whatever its line ends and wherever its chunks split", async () => {
    const userFrame = frame("7.1.1", user);
    const comma = userFrame.indexOf(",") + 1;
    const text = [
      ": heartbeat\r\n\r\n",
      `retry: 10\r\nid: 7.1.1\r\ndata: ${userFrame.slice(0, comma)}\r\ndata: ${userFrame.slice(comma)}\r\n\r\n`,
      "event: other\ndata: {}\n\nid: nothing\n\n",
      `data:${frame("7.2.1", reply)}\r\r`,
      `event: ended\ndata: ${JSON.stringify({ sessionId: "7", error: { code: "session_not_found", message: "Gone" } })}\n\n`,
    ].join("");
    const bytes = [...encoder.encode(text)].map((byte) => Uint8Array.of(byte));
    const { requests, fetch } = scripted(bytes, []);
    const client = clientOf(httpTransport({ baseUrl: "http://motoko.test/motoko/", fetch }));
    const heard: MotokoSessionState[] = [];
    client.follow("7", (state) => heard.push(state));
    await eventually(() => status(client, "7") === "ended");

    const state = client.sessionState("7");
    expect(state.view).toEqual(foldEvents([user, reply]));
    expect(state.cursor).toBe("7.2.1");
    expect(state.error).toMatchObject({ code: "session_not_found", message: "Gone" });
    expect(heard.map((heardState) => heardState.status)).toEqual(["live", "live", "live", "ended"]);
    expect(requests.map(({ url }) => url)).toEqual(["http://motoko.test/motoko/sessions/7/events"]);
    expect(requests[0]!.headers.get("accept")).toBe("text/event-stream");
    expect(requests[0]!.headers.has("last-event-id")).toBe(false);
  });

  it("goes on with a follow whose follower throws at each state it hears", async () => {
    const { requests, fetch } = scripted([encoder.encode(`data: ${frame("7.1.1", user)}\n\n`)]);
    const client = clientOf(httpTransport({ baseUrl: "http://motoko.test/motoko", fetch }));

    const thrown = await uncaughtErrors(async () => {
      client.follow("7", () => {
        throw new Error("Not ready");
      });
      await eventually(() => client.sessionState("7").cursor === "7.1.1", 1_000);
    });

    expect(client.sessionState("7")).toMatchObject({ status: "live", view: foldEvents([user]) });
    expect(requests).toHaveLength(1);
    expect(thrown).toEqual([new Error("Not ready"), new Error("Not ready")]);
  });

  it("tries a follow again after a backoff when the server cannot be reached, or its stream ends", async () => {
    const { requests, fetch } = scripted(
      new TypeError("fetch failed"),
      [encoder.encode(`data: ${frame("7.1.1", user)}\n\n`)],
      [encoder.encode(`data: ${frame("7.2.1", reply)}\n\n`)],
    );
    const client = clientOf(httpTransport({ baseUrl: "http://motoko.test/motoko", fetch }));
    client.follow("7", () => undefined);

    await eventually(() => client.sessionState("7").cursor === "7.2.1");
    expect(status(client, "7")).toBe("live");
    expect(client.sessionState("7").view).toEqual(foldEvents([user, reply]));
    expect(requests.map(({ headers }) => headers.get("last-event-id"))).toEqual([null, null, "7.1.1"]);
  });

  it("tries a follow again when the server cannot serve it now, and keeps its cursor", async () => {
    const { requests, fetch } = scripted(
      [encoder.encode(`data: ${frame("7.1.1", user)}\n\n`)],
      Response.json({ error: { code: "lease_held", message: "Leased elsewhere" } }, { status: 503 }),
      new Response("<h1>Bad gateway</h1>", { status: 502, headers: { "content-type": "text/html" } }),
      [encoder.encode(`data: ${frame("7.2.1", reply)}\n\n`)],
    );
    const client = clientOf(httpTransport({ baseUrl: "http://motoko.test/motoko", fetch }));
    client.follow("7", () => undefined);

    await eventually(() => client.sessionState("7").cursor === "7.2.1");
    expect(status(client, "7")).toBe("live");
    expect(client.sessionState("7").error).toBeUndefined();
    expect(client.sessionState("7").view).toEqual(foldEvents([user, reply]));
    expect(requests.map(({ headers }) => headers.get("last-event-id"))).toEqual([null, "7.1.1", "7.1.1", "7.1.1"]);
  });
});
