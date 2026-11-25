// Each test expects what the README's "Deferred tools" says.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { StorageWrite } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { delegateOf, foldEvents } from "@chia1104/motoko-wire";
import type { AgentSessionView, StreamItem, ToolItem } from "@chia1104/motoko-wire";

import {
  ApprovalNotPendingError,
  callErrorOf,
  createAgentRuntime,
  defineAgent,
  defineDeferredTool,
  defineDelegate,
  InvalidRequestError,
  ReplyNotPendingError,
  runCall,
  scopeKey,
  SessionNotFoundError,
} from "../src/index.ts";
import type {
  AgentHost,
  AgentRuntime,
  AgentRuntimeOptions,
  DeferredContext,
  DeliverReply,
  InstanceReport,
  ReplyAddress,
} from "../src/index.ts";
import { setCourierTimingForTests } from "../src/runtime.ts";

import {
  durableMemoryHost,
  eventually,
  expectEveryResumeFolds,
  fauxModels,
  follow,
  isRunEnd,
  memoryHost,
  memoryPlace,
  readUntil,
  settledTypes,
} from "./helpers.ts";
import type { MemoryPlace } from "./helpers.ts";

interface Started {
  readonly question: string;
  readonly requestId: string;
  readonly replyTo: ReplyAddress;
  readonly sessionId: string;
  readonly toolCallId: string;
}

interface Ports {
  readonly started: Started[];
  readonly cancelled: Started[];
  onStart?: (context: DeferredContext<Ports>) => Promise<void>;
}

const record = ({ question }: { question: string }, context: DeferredContext<Ports>): Started => ({
  question,
  requestId: context.requestId,
  replyTo: context.replyTo,
  sessionId: context.sessionId,
  toolCallId: context.toolCallId,
});

const askSpec = {
  name: "ask",
  description: "Ask someone elsewhere",
  label: "Ask",
  tier: "ask",
  parameters: z.object({ question: z.string() }),
  async start(args: { question: string }, context: DeferredContext<Ports>) {
    context.ports.started.push(record(args, context));
    await context.ports.onStart?.(context);
  },
  async cancel(args: { question: string }, context: DeferredContext<Ports>) {
    context.ports.cancelled.push(record(args, context));
  },
};

const ask = defineDeferredTool(askSpec);

const asker = defineAgent<Ports>({ kind: "asker", instructions: "You ask others.", tools: [ask] });

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

const askCall = (question: string, id = "q-1") =>
  fauxAssistantMessage(fauxToolCall("ask", { question }, { id }), { stopReason: "toolUse" });

function script(faux: ReturnType<typeof fauxModels>["faux"], steps: FauxResponseStep[]) {
  const requests: Message[][] = [];
  const respond: FauxResponseFactory = async (request, options, state, model) => {
    requests.push([...request.messages]);
    const step = steps.shift();
    if (step === undefined) throw new Error("No response left");
    return typeof step === "function" ? step(request, options, state, model) : step;
  };
  faux.setResponses(Array.from({ length: 32 }, () => respond));
  return requests;
}

const fold = (items: readonly StreamItem[]): AgentSessionView => foldEvents(items.map((item) => item.event));

const toolItem = (view: AgentSessionView, toolCallId: string) =>
  view.items.find((item): item is ToolItem => item.kind === "tool" && item.toolCallId === toolCallId);

const resultOf = (requests: Message[][]) => requests.at(-1)?.at(-1);

function setup(options: { host?: AgentHost; closeIdleAfterMs?: number; agents?: readonly (typeof asker)[] } = {}) {
  const models = fauxModels();
  const ports: Ports = { started: [], cancelled: [] };
  runtime = createAgentRuntime({
    agents: options.agents ?? [asker],
    host: options.host ?? memoryHost(),
    models: models.models,
    ports,
    defaultModel: models.model,
    ...(options.closeIdleAfterMs !== undefined && { closeIdleAfterMs: options.closeIdleAfterMs }),
  });
  return { faux: models.faux, ports, runtime, instance: runtime.get(options.agents?.[0] ?? asker, "alice") };
}

const replyTo = (instance: ReturnType<AgentRuntime["get"]>, started: Started, text: string, isError?: boolean) =>
  instance.session(started.replyTo.sessionId).reply({
    toolCallId: started.replyTo.toolCallId,
    token: started.replyTo.token,
    text,
    ...(isError !== undefined && { isError }),
  });

describe("a deferred call", () => {
  it("starts its work with a reply address, parks on it, and returns the reply as its result", async () => {
    const { faux, ports, instance } = setup();
    const requests = script(faux, [askCall("Why?"), fauxAssistantMessage("Bob says: because.")]);
    const session = instance.session((await instance.createSession()).id);
    const live = follow(session);
    await session.submit({ text: "Ask Bob why", requestId: "1" });
    const waiting = [...(await live.until((items) => items.some((item) => item.event.type === "reply:wait")))];
    const [started] = ports.started;
    expect(started).toEqual({
      question: "Why?",
      requestId: expect.stringContaining(session.id),
      replyTo: { scope: instance.scope, sessionId: session.id, toolCallId: "q-1", token: expect.any(String) },
      sessionId: session.id,
      toolCallId: "q-1",
    });
    expect(waiting.at(-1)?.event).toEqual({ type: "reply:wait", toolCallId: "q-1", until: expect.any(Number) });
    const view = fold(waiting);
    expect(toolItem(view, "q-1")).toMatchObject({ status: "awaiting_reply", replyBy: expect.any(Number) });
    expect(view).toMatchObject({ status: "running", pendingApprovals: [] });
    await expectEveryResumeFolds(session, waiting);

    expect(await replyTo(instance, started!, "Because.")).toEqual({ outcome: "applied" });
    const items = [...(await live.until((read) => read.some((item) => isRunEnd(item.event))))];
    expect(settledTypes(items)).toEqual([
      "run:start",
      "user",
      "assistant:end",
      "tool:start",
      "reply:wait",
      "tool:end",
      "assistant:end",
      "run:end",
    ]);
    const types = items.map((item) => item.event.type);
    expect(types.slice(types.indexOf("reply:wait"), types.indexOf("tool:end") + 1)).toEqual([
      "reply:wait",
      "tool:update",
      "tool:end",
    ]);
    const ended = fold(items);
    const call = toolItem(ended, "q-1")!;
    expect(call).toMatchObject({ toolName: "ask", label: "Ask", tier: "ask", status: "ok" });
    expect(call.replyBy).toBeUndefined();
    expect(delegateOf(call)).toBeUndefined();
    expect(resultOf(requests)).toMatchObject({
      role: "toolResult",
      toolCallId: "q-1",
      isError: false,
      content: [{ type: "text", text: "Because." }],
    });
    expect(ports.started).toHaveLength(1);
    await expectEveryResumeFolds(session, items);
    await live.stop();
  });

  it("returns an error result for a reply that says so", async () => {
    const { faux, ports, instance } = setup();
    const requests = script(faux, [askCall("Why?"), fauxAssistantMessage("Bob could not say.")]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Ask Bob why", requestId: "1" });
    await readUntil(session, (event) => event.type === "reply:wait");
    await replyTo(instance, ports.started[0]!, "Bob is away.", true);
    expect(toolItem(fold(await readUntil(session, isRunEnd)), "q-1")).toMatchObject({
      status: "error",
      error: "Bob is away.",
    });
    expect(resultOf(requests)).toMatchObject({ isError: true, content: [{ type: "text", text: "Bob is away." }] });
  });

  it("is completed by a reply that reopens its instance, closed or closed for idleness while it waits", async () => {
    const place = memoryPlace();
    const { faux, ports, runtime: first } = setup({ host: durableMemoryHost(place), closeIdleAfterMs: 100 });
    const requests = script(faux, [
      askCall("One?", "q-1"),
      fauxAssistantMessage("One done."),
      askCall("Two?", "q-2"),
      fauxAssistantMessage("Two done."),
    ]);
    const closed = first.get(asker, "alice");
    const sessionId = (await closed.createSession()).id;
    await closed.session(sessionId).submit({ text: "One", requestId: "1" });
    await readUntil(closed.session(sessionId), (event) => event.type === "reply:wait");
    await closed.close();
    expect(closed.state).toBe("closed");

    const again = first.get(asker, "alice");
    expect(await replyTo(again, ports.started[0]!, "Yes.")).toEqual({ outcome: "applied" });
    await readUntil(
      again.session(sessionId),
      (_event, items) => items.filter((item) => isRunEnd(item.event)).length === 1,
    );
    expect(resultOf(requests)).toMatchObject({ content: [{ type: "text", text: "Yes." }] });

    await again.session(sessionId).submit({ text: "Two", requestId: "2" });
    await readUntil(again.session(sessionId), (event) => event.type === "reply:wait" && event.toolCallId === "q-2");
    await eventually(() => again.state === "dormant");
    expect(await replyTo(again, ports.started[1]!, "Also yes.")).toEqual({ outcome: "applied" });
    await readUntil(
      again.session(sessionId),
      (_event, items) => items.filter((item) => isRunEnd(item.event)).length === 2,
    );
    expect(resultOf(requests)).toMatchObject({ content: [{ type: "text", text: "Also yes." }] });
    expect(ports.started).toHaveLength(2);
  });

  it("is completed by a reply that comes before it parks", async () => {
    const { faux, ports, instance } = setup();
    const requests = script(faux, [askCall("Why?"), fauxAssistantMessage("Done.")]);
    ports.onStart = async (context) => {
      const started = ports.started.at(-1)!;
      expect(await replyTo(instance, started, "Right away.")).toEqual({ outcome: "applied" });
      expect(context.signal.aborted).toBe(false);
    };
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Ask", requestId: "1" });
    expect(toolItem(fold(await readUntil(session, isRunEnd)), "q-1")).toMatchObject({ status: "ok" });
    expect(resultOf(requests)).toMatchObject({ content: [{ type: "text", text: "Right away." }] });
    expect(ports.started).toHaveLength(1);
  });

  it("refuses a wrong token, a reply to a call that ended without one, and says a second reply came already", async () => {
    const { faux, ports, instance } = setup();
    script(faux, [
      askCall("Why?"),
      fauxAssistantMessage("Done."),
      askCall("Again?", "q-2"),
      fauxAssistantMessage("No."),
    ]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Ask", requestId: "1" });
    await readUntil(session, (event) => event.type === "reply:wait");
    const started = ports.started[0]!;

    const wrong = { toolCallId: "q-1", token: `${started.replyTo.token.slice(0, -1)}x`, text: "Forged." };
    await expect(session.reply(wrong)).rejects.toBeInstanceOf(ReplyNotPendingError);
    await expect(session.reply({ ...wrong, toolCallId: "nobody" })).rejects.toBeInstanceOf(ReplyNotPendingError);
    const over = await runCall(instance, { method: "reply", params: { sessionId: session.id, ...wrong } }).catch(
      (error: unknown) => error,
    );
    expect(callErrorOf(over)).toMatchObject({ code: "reply_not_pending" });

    expect(await replyTo(instance, started, "Because.")).toEqual({ outcome: "applied" });
    expect(await replyTo(instance, started, "Because, again.")).toEqual({ outcome: "already_replied" });
    await readUntil(session, isRunEnd);
    const params = { sessionId: session.id, toolCallId: "q-1", token: started.replyTo.token, text: "Late." };
    expect(await runCall(instance, { method: "reply", params })).toEqual({ outcome: "already_replied" });

    ports.onStart = async () => {
      throw new Error("Bob cannot be reached.");
    };
    await session.submit({ text: "Ask again", requestId: "2" });
    const view = fold(
      await readUntil(session, (_event, items) => items.filter((item) => isRunEnd(item.event)).length === 2),
    );
    expect(toolItem(view, "q-2")).toMatchObject({ status: "error", error: "Bob cannot be reached." });
    await expect(replyTo(instance, ports.started[1]!, "Too late.")).rejects.toBeInstanceOf(ReplyNotPendingError);
  });

  it("returns an error result once its deadline passes, and refuses a reply after it", async () => {
    const quick = defineDeferredTool({ ...askSpec, timeoutMs: 150 });
    const impatient = defineAgent<Ports>({ kind: "asker", instructions: "You ask others.", tools: [quick] });
    const { faux, ports, instance } = setup({ agents: [impatient] });
    const requests = script(faux, [askCall("Why?"), fauxAssistantMessage("Nobody answered.")]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Ask", requestId: "1" });
    const view = fold(await readUntil(session, isRunEnd));
    expect(toolItem(view, "q-1")).toMatchObject({ status: "error", error: "No reply came in time." });
    expect(resultOf(requests)).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "No reply came in time." }],
    });
    await expect(replyTo(instance, ports.started[0]!, "Too late.")).rejects.toBeInstanceOf(ReplyNotPendingError);
  });

  it("refuses a deadline that is not a positive number of milliseconds", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => defineDeferredTool({ ...askSpec, timeoutMs })).toThrow(TypeError);
    }
    expect(ask).toMatchObject({ kind: "deferred", replay: "safe", timeoutMs: 24 * 60 * 60 * 1000, label: "Ask" });
  });

  it("is stopped with its session: cancel runs with the call's address, and a reply after it is refused", async () => {
    const { faux, ports, instance } = setup();
    script(faux, [askCall("Why?")]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Ask", requestId: "1" });
    await readUntil(session, (event) => event.type === "reply:wait");

    await session.abort();
    expect(fold(await readUntil(session, isRunEnd)).items.at(-1)).toMatchObject({ kind: "notice", reason: "aborted" });
    expect(ports.cancelled).toEqual(ports.started);
    await expect(replyTo(instance, ports.started[0]!, "Too late.")).rejects.toBeInstanceOf(ReplyNotPendingError);
  });

  it("asks for approval before its work starts, when its tier is gated", async () => {
    const gated = defineAgent<Ports>({
      kind: "asker",
      instructions: "You ask others.",
      tools: [ask],
      policy: { requiresApproval: ["ask"] },
    });
    const { faux, ports, instance } = setup({ agents: [gated] });
    script(faux, [askCall("Why?"), fauxAssistantMessage("Done.")]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Ask", requestId: "1" });
    await readUntil(session, (event) => event.type === "approval:request");
    expect(ports.started).toEqual([]);

    await session.approve([{ toolCallId: "q-1", approved: true }]);
    const waiting = await readUntil(session, (event) => event.type === "reply:wait");
    expect(ports.started).toHaveLength(1);
    expect(fold(waiting)).toMatchObject({ status: "running", pendingApprovals: [] });
    await expect(session.approve([{ toolCallId: "q-1", approved: true }])).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
    await replyTo(instance, ports.started[0]!, "Because.");
    expect(toolItem(fold(await readUntil(session, isRunEnd)), "q-1")).toMatchObject({
      status: "ok",
      approval: { approved: true },
    });
  });

  it("in a sub-agent's child session, is completed by a reply addressed to the child", async () => {
    const helper = defineAgent<Ports>({ kind: "helper", instructions: "You help by asking.", tools: [ask] });
    const lead = defineAgent<Ports>({
      kind: "asker",
      instructions: "You lead.",
      tools: [defineDelegate({ name: "delegate", description: "Hand a task over", tier: "delegate", agent: helper })],
    });
    const { faux, ports, instance } = setup({ agents: [lead] });
    const requests = script(faux, [
      fauxAssistantMessage(fauxToolCall("delegate", { task: "Ask Bob" }, { id: "d-1" }), { stopReason: "toolUse" }),
      askCall("Why?"),
      fauxAssistantMessage("Bob says because."),
      fauxAssistantMessage("The helper says Bob says because."),
    ]);
    const parent = instance.session((await instance.createSession()).id);
    await parent.submit({ text: "Find out", requestId: "1" });
    await eventually(() => ports.started.length === 1);
    const started = ports.started[0]!;
    expect(started.replyTo.sessionId).not.toBe(parent.id);
    const child = instance.session(started.replyTo.sessionId);
    await readUntil(child, (event) => event.type === "reply:wait");

    expect(await replyTo(instance, started, "Because.")).toEqual({ outcome: "applied" });
    expect(toolItem(fold(await readUntil(parent, isRunEnd)), "d-1")).toMatchObject({ status: "ok" });
    expect(resultOf(requests)).toMatchObject({ content: [{ type: "text", text: "Bob says because." }] });
    expect(toolItem(fold(await readUntil(child, isRunEnd)), "q-1")).toMatchObject({ status: "ok" });
  });
});

function beforeCommits(place: MemoryPlace, before: (writes: readonly StorageWrite[]) => Promise<void>): AgentHost {
  const base = durableMemoryHost(place);
  return {
    ...base,
    async storage(scope, lease) {
      const storage = await base.storage(scope, lease);
      return new Proxy(storage, {
        get(object, property) {
          if (property === "commit") {
            return async (...args: Parameters<typeof storage.commit>) => {
              await before(args[0].flat());
              return object.commit(...args);
            };
          }
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
}

function crashingHost(place: MemoryPlace, crashes: (writes: readonly StorageWrite[]) => boolean): AgentHost {
  let crashed = false;
  return beforeCommits(place, async (writes) => {
    if (crashed || !crashes(writes)) return;
    crashed = true;
    throw new Error("The process died");
  });
}

function holdingHost(place: MemoryPlace, holds: (writes: readonly StorageWrite[]) => boolean) {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  const host = beforeCommits(place, async (writes) => {
    if (held || !holds(writes)) return;
    held = true;
    reach();
    await released;
  });
  return { host, reached, release };
}

const parksOnReply = (writes: readonly StorageWrite[]) =>
  writes.some(
    (write) =>
      write.type === "task" &&
      write.value.state.status === "sleeping" &&
      write.value.state.signals?.some((key) => key.signal === "runtime.reply") === true,
  );

describe("a deferred call cut off by a crash before it parks", () => {
  it("starts its work again with the same request ID and reply address, and takes the reply", async () => {
    const place = memoryPlace();
    const models = fauxModels();
    const ports: Ports = { started: [], cancelled: [] };
    const options = { agents: [asker], models: models.models, ports, defaultModel: models.model };
    const requests = script(models.faux, [askCall("Why?"), fauxAssistantMessage("Because, Bob says.")]);
    runtime = createAgentRuntime({ ...options, host: crashingHost(place, parksOnReply) });
    const first = runtime.get(asker, "alice");
    const sessionId = (await first.createSession()).id;
    await first.session(sessionId).submit({ text: "Ask", requestId: "1" });
    await eventually(() => first.state === "failed");
    await runtime.close();
    expect(ports.started).toHaveLength(1);

    runtime = createAgentRuntime({ ...options, host: durableMemoryHost(place) });
    const again = runtime.get(asker, "alice");
    await again.open();
    await readUntil(again.session(sessionId), (event) => event.type === "reply:wait");
    expect(ports.started).toHaveLength(2);
    expect(ports.started[1]).toEqual(ports.started[0]);
    expect(await replyTo(again, ports.started[1]!, "Because.")).toEqual({ outcome: "applied" });
    expect(toolItem(fold(await readUntil(again.session(sessionId), isRunEnd)), "q-1")).toMatchObject({ status: "ok" });
    expect(resultOf(requests)).toMatchObject({ content: [{ type: "text", text: "Because." }] });
  });
});

const context = BACKGROUND_CONTEXT;

const responder = defineAgent<Ports>({ kind: "bob", instructions: "You are Bob, and you answer.", tools: [] });

type Role = "alice" | "bob";

function scripts(faux: ReturnType<typeof fauxModels>["faux"], steps: Record<Role, FauxResponseStep[]>) {
  const requests: Record<Role, Message[][]> = { alice: [], bob: [] };
  const respond: FauxResponseFactory = async (request, options, state, model) => {
    const role: Role = JSON.stringify(request.messages).includes(responder.instructions) ? "bob" : "alice";
    requests[role].push([...request.messages]);
    const step = steps[role].shift();
    if (step === undefined) throw new Error(`No ${role} response left`);
    return typeof step === "function" ? step(request, options, state, model) : step;
  };
  faux.setResponses(Array.from({ length: 32 }, () => respond));
  return requests;
}

function held(text: string) {
  let release!: () => void;
  let start!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (start = resolve));
  const step: FauxResponseFactory = async (_request, options) => {
    start();
    await new Promise<void>((resolve) => {
      void released.then(resolve);
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage(text);
  };
  return { step, started, release };
}

interface AskOptions {
  readonly place?: MemoryPlace;
  readonly host?: AgentHost;
  readonly failures?: number;
  readonly closeIdleAfterMs?: number;
  readonly settings?: AgentRuntimeOptions<Ports>["settings"];
  readonly wrapDeliver?: (deliver: DeliverReply) => DeliverReply;
}

async function askSetup(options: AskOptions = {}) {
  const place = options.place ?? memoryPlace();
  const models = fauxModels();
  const ports: Ports = { started: [], cancelled: [] };
  const deliveries: string[] = [];
  const reports: InstanceReport[] = [];
  let failures = options.failures ?? 0;
  const deliverReply: DeliverReply = async ({ to, text, isError }) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("Alice's home cannot be reached");
    }
    try {
      const session = runtime!.get(to.scope.kind, to.scope.name).session(to.sessionId);
      deliveries.push((await session.reply({ toolCallId: to.toolCallId, token: to.token, text, isError })).outcome);
    } catch (error) {
      if (!(error instanceof ReplyNotPendingError || error instanceof SessionNotFoundError)) throw error;
      deliveries.push("refused");
    }
  };
  const created = createAgentRuntime({
    agents: [asker, responder],
    host: options.host ?? durableMemoryHost(place),
    models: models.models,
    ports,
    defaultModel: models.model,
    deliverReply: options.wrapDeliver?.(deliverReply) ?? deliverReply,
    onReport: (report) => reports.push(report),
    ...(options.closeIdleAfterMs !== undefined && { closeIdleAfterMs: options.closeIdleAfterMs }),
    ...(options.settings !== undefined && { settings: options.settings }),
  });
  runtime = created;
  setCourierTimingForTests(created, { firstMs: 5, maxMs: 20 });
  const bobs = (await created.get(responder, "bob").createSession()).id;
  ports.onStart = async ({ requestId, replyTo }) => {
    const { question } = ports.started.at(-1)!;
    await created.get(responder, "bob").session(bobs).submit({ text: question, requestId, replyTo });
  };
  const alice = created.get(asker, "alice");
  const session = alice.session((await alice.createSession()).id);
  return { faux: models.faux, place, ports, deliveries, reports, runtime: created, alice, session, bobs };
}

const replyFailures = (reports: readonly InstanceReport[]) =>
  reports.flatMap((report) => (report.source === "runtime" && report.kind === "reply_failed" ? [report] : []));

async function bobStored(place: MemoryPlace) {
  const storage = place.storages.get(scopeKey({ kind: responder.kind, name: "bob" }))!;
  const tasks = (await storage.scanTasks({ kind: "runtime.ask" }, 100, undefined, context)).items;
  const submissions = (await storage.scanSubmissions({}, 100, undefined, context)).items;
  return { couriers: tasks.map((task) => task.state.status), submissions: submissions.length };
}

async function courierDone(place: MemoryPlace) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const stored = await bobStored(place);
    if (stored.couriers.every((status) => status === "terminal") || Date.now() > deadline) return stored;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("an ask", () => {
  it("delivers the asked run's answer, which the asking call returns", async () => {
    const { faux, place, deliveries, reports, session, runtime: both, bobs } = await askSetup();
    const requests = scripts(faux, {
      alice: [askCall("Why is the sky blue?"), fauxAssistantMessage("Bob says: scattering.")],
      bob: [fauxAssistantMessage("Rayleigh scattering.")],
    });
    const live = follow(session);
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await live.until((items) => items.some((item) => isRunEnd(item.event)));
    await live.stop();

    expect(settledTypes(live.items)).toEqual([
      "run:start",
      "user",
      "assistant:end",
      "tool:start",
      "reply:wait",
      "tool:end",
      "assistant:end",
      "run:end",
    ]);
    const atWait = live.items.findIndex((item) => item.event.type === "reply:wait");
    expect(toolItem(fold(live.items.slice(0, atWait + 1)), "q-1")).toMatchObject({ status: "awaiting_reply" });
    expect(toolItem(fold(live.items), "q-1")).toMatchObject({ status: "ok" });
    expect(resultOf(requests.alice)).toMatchObject({
      toolCallId: "q-1",
      isError: false,
      content: [{ type: "text", text: "Rayleigh scattering." }],
    });
    const bob = both.get(responder, "bob").session(bobs);
    expect(fold(await readUntil(bob, isRunEnd)).items).toMatchObject([
      { kind: "user", text: "Why is the sky blue?" },
      { kind: "assistant", text: "Rayleigh scattering." },
    ]);
    expect(deliveries).toEqual(["applied"]);
    expect(replyFailures(reports)).toEqual([]);
    expect(await courierDone(place)).toEqual({ couriers: ["terminal"], submissions: 1 });
  });

  it("returns the first submission for a retry, and asks once", async () => {
    const { faux, place, ports, deliveries, session, runtime: both, bobs } = await askSetup();
    const answer = held("Later.");
    scripts(faux, { alice: [askCall("Now?"), fauxAssistantMessage("Done.")], bob: [answer.step] });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await answer.started;
    const { requestId, replyTo } = ports.started[0]!;
    const bob = both.get(responder, "bob").session(bobs);
    const first = await bob.submit({ text: "Now?", requestId, replyTo });
    expect(await bob.submit({ text: "Now?", requestId, replyTo })).toEqual(first);
    answer.release();
    await readUntil(session, isRunEnd);
    await eventually(() => deliveries.length === 1);
    expect(deliveries).toEqual(["applied"]);
    expect(await courierDone(place)).toEqual({ couriers: ["terminal"], submissions: 1 });
  });

  it("cannot be withdrawn: its asker waits for its answer", async () => {
    const { faux, ports, deliveries, session, runtime: both, bobs } = await askSetup();
    const answer = held("Later.");
    scripts(faux, { alice: [askCall("Now?"), fauxAssistantMessage("Done.")], bob: [answer.step] });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await answer.started;
    const { requestId, replyTo } = ports.started[0]!;
    const bob = both.get(responder, "bob").session(bobs);
    const { submissionId } = await bob.submit({ text: "Now?", requestId, replyTo });
    await expect(bob.withdraw(submissionId)).rejects.toBeInstanceOf(InvalidRequestError);
    answer.release();
    await readUntil(session, isRunEnd);
    await eventually(() => deliveries.length === 1);
    expect(deliveries).toEqual(["applied"]);
  });

  it("is a plain retry of a request first submitted without a reply address, and asks nothing", async () => {
    const { faux, place, reports, runtime: both, bobs } = await askSetup();
    scripts(faux, { alice: [], bob: [fauxAssistantMessage("Hello."), fauxAssistantMessage("Unused.")] });
    const bob = both.get(responder, "bob").session(bobs);
    const replyTo: ReplyAddress = {
      scope: { kind: "asker", name: "alice" },
      sessionId: "1",
      toolCallId: "q-1",
      token: "t",
    };
    const first = await bob.submit({ text: "Hi", requestId: "r-1" });
    expect(await bob.submit({ text: "Hi", requestId: "r-1", replyTo })).toEqual(first);
    await readUntil(bob, isRunEnd);
    expect(await bobStored(place)).toEqual({ couriers: [], submissions: 1 });
    expect(replyFailures(reports)).toEqual([]);
  });

  it("reopens the asking instance, closed or closed for idleness while it waits, to complete its call", async () => {
    const { faux, deliveries, session, alice } = await askSetup({ closeIdleAfterMs: 100 });
    const first = held("One.");
    const second = held("Two.");
    const requests = scripts(faux, {
      alice: [
        askCall("One?", "q-1"),
        fauxAssistantMessage("Got one."),
        askCall("Two?", "q-2"),
        fauxAssistantMessage("Got two."),
      ],
      bob: [first.step, second.step],
    });
    await session.submit({ text: "Ask one", requestId: "1" });
    await first.started;
    await alice.close();
    first.release();
    await eventually(() => deliveries.length === 1);
    expect(deliveries).toEqual(["applied"]);
    const again = runtime!.get(asker, "alice").session(session.id);
    await readUntil(again, isRunEnd);
    expect(resultOf(requests.alice)).toMatchObject({ content: [{ type: "text", text: "One." }] });

    await again.submit({ text: "Ask two", requestId: "2" });
    await second.started;
    await eventually(() => runtime!.get(asker, "alice").state === "dormant");
    second.release();
    await eventually(() => deliveries.length === 2);
    expect(deliveries).toEqual(["applied", "applied"]);
    await readUntil(again, (_event, items) => items.filter((item) => isRunEnd(item.event)).length === 2);
    expect(resultOf(requests.alice)).toMatchObject({ content: [{ type: "text", text: "Two." }] });
  });

  it("is retried until a delivery goes through, with each failure reported", async () => {
    const { faux, deliveries, reports, session, alice } = await askSetup({ failures: 2 });
    const requests = scripts(faux, {
      alice: [askCall("Why?"), fauxAssistantMessage("Done.")],
      bob: [fauxAssistantMessage("Because.")],
    });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await readUntil(session, isRunEnd);
    expect(resultOf(requests.alice)).toMatchObject({ content: [{ type: "text", text: "Because." }] });
    expect(deliveries).toEqual(["applied"]);
    const failed = replyFailures(reports);
    expect(failed).toEqual(
      [1, 2].map((attempt) => ({
        source: "runtime",
        scope: { kind: "bob", name: "bob" },
        kind: "reply_failed",
        sessionId: expect.any(String),
        requestId: expect.any(String),
        to: { scope: alice.scope, sessionId: session.id, toolCallId: "q-1" },
        attempt,
        gaveUp: false,
        error: new Error("Alice's home cannot be reached"),
      })),
    );
  });

  it("is delivered once its asked instance reopens, when a close cut a delivery off", async () => {
    let cut!: () => void;
    const cutting = new Promise<void>((resolve) => (cut = resolve));
    let stalls = 1;
    const {
      faux,
      place,
      deliveries,
      reports,
      session,
      runtime: both,
    } = await askSetup({
      wrapDeliver: (deliver) => async (reply, signal) => {
        if (stalls === 0) return deliver(reply, signal);
        stalls -= 1;
        cut();
        await new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("closed mid-delivery")), { once: true }),
        );
      },
    });
    const requests = scripts(faux, {
      alice: [askCall("Why?"), fauxAssistantMessage("Done.")],
      bob: [fauxAssistantMessage("Because.")],
    });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await cutting;
    await both.get(responder, "bob").close();
    await both.get(responder, "bob").open();
    await readUntil(session, isRunEnd);
    expect(resultOf(requests.alice)).toMatchObject({ content: [{ type: "text", text: "Because." }] });
    expect(deliveries).toEqual(["applied"]);
    expect(replyFailures(reports)).toEqual([]);
    expect(await courierDone(place)).toEqual({ couriers: ["terminal"], submissions: 1 });
  });

  it("gives up a day after its first delivery, and says so", async () => {
    const {
      faux,
      deliveries,
      reports,
      session,
      runtime: both,
    } = await askSetup({ failures: Number.POSITIVE_INFINITY });
    setCourierTimingForTests(both, { firstMs: 5, maxMs: 5, giveUpMs: 60 });
    scripts(faux, { alice: [askCall("Why?")], bob: [fauxAssistantMessage("Because.")] });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await eventually(() => replyFailures(reports).some((failure) => failure.gaveUp));
    const failed = replyFailures(reports);
    expect(failed.length).toBeGreaterThan(1);
    expect(failed.filter((failure) => failure.gaveUp)).toHaveLength(1);
    expect(failed.at(-1)).toMatchObject({ gaveUp: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replyFailures(reports)).toHaveLength(failed.length);
    expect(deliveries).toEqual([]);
  });

  it.each([
    [
      "fails",
      () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      /503 service unavailable/,
    ],
    ["is aborted", undefined, /aborted/],
  ])("returns an error result that says why when the asked run %s", async (_how, failure, why) => {
    const { faux, session, runtime: both, bobs } = await askSetup({ settings: { retry: { enabled: false } } });
    const answer = held("never read");
    const requests = scripts(faux, {
      alice: [askCall("Why?"), fauxAssistantMessage("Bob could not answer.")],
      bob: [failure?.() ?? answer.step],
    });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    if (failure === undefined) {
      await answer.started;
      await both.get(responder, "bob").session(bobs).abort();
    }
    const view = fold(await readUntil(session, isRunEnd));
    expect(toolItem(view, "q-1")).toMatchObject({ status: "error", error: expect.stringMatching(why) });
    expect(resultOf(requests.alice)).toMatchObject({ toolCallId: "q-1", isError: true });
  });

  it("is told its asker stopped waiting: the asker's cancel runs, the reply is refused, and the courier ends", async () => {
    const { faux, place, ports, deliveries, reports, session } = await askSetup();
    const answer = held("Too late.");
    scripts(faux, { alice: [askCall("Why?")], bob: [answer.step] });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await answer.started;
    await session.abort();
    expect(ports.cancelled).toEqual(ports.started);

    answer.release();
    await eventually(() => deliveries.length === 1);
    expect(deliveries).toEqual(["refused"]);
    expect(replyFailures(reports)).toEqual([]);
    expect(await courierDone(place)).toEqual({ couriers: ["terminal"], submissions: 1 });
  });

  it("sends nothing once its asked session is deleted: the courier is aborted, and the asker still waits", async () => {
    const { faux, place, deliveries, reports, session, runtime: both, bobs } = await askSetup();
    const answer = held("never read");
    scripts(faux, { alice: [askCall("Why?")], bob: [answer.step] });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await answer.started;
    await both.get(responder, "bob").session(bobs).delete();

    expect(await courierDone(place)).toEqual({ couriers: ["terminal"], submissions: 1 });
    const storage = place.storages.get(scopeKey({ kind: responder.kind, name: "bob" }))!;
    const [courier] = (await storage.scanTasks({ kind: "runtime.ask" }, 1, undefined, context)).items;
    expect(courier?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
    expect(deliveries).toEqual([]);
    expect(replyFailures(reports)).toEqual([]);
    expect(toolItem(fold(await readUntil(session, (event) => event.type === "reply:wait")), "q-1")).toMatchObject({
      status: "awaiting_reply",
    });
  });

  it("is refused without deliverReply, and with whenBusy: reject, as an invalid request", async () => {
    const { ports, runtime: both, bobs } = await askSetup();
    const replyTo: ReplyAddress = {
      scope: { kind: "asker", name: "alice" },
      sessionId: "1",
      toolCallId: "q-1",
      token: "t",
    };
    const bob = both.get(responder, "bob");
    const busy = bob.session(bobs).submit({ text: "Hi", requestId: "1", replyTo, whenBusy: "reject" });
    await expect(busy).rejects.toBeInstanceOf(InvalidRequestError);
    const over = await runCall(bob, {
      method: "submit",
      params: { sessionId: bobs, text: "Hi", requestId: "1", replyTo, whenBusy: "reject" },
    }).catch((error: unknown) => error);
    expect(callErrorOf(over)).toMatchObject({ code: "invalid_request" });
    const steer = bob.session(bobs).submit({ text: "Hi", requestId: "1", replyTo, whenBusy: "steer" });
    await expect(steer).rejects.toBeInstanceOf(InvalidRequestError);

    const models = fauxModels();
    const plain = createAgentRuntime({
      agents: [responder],
      host: memoryHost(),
      models: models.models,
      ports,
      defaultModel: models.model,
    });
    try {
      const instance = plain.get(responder, "bob");
      const id = (await instance.createSession()).id;
      await expect(instance.session(id).submit({ text: "Hi", requestId: "1", replyTo })).rejects.toBeInstanceOf(
        InvalidRequestError,
      );
      expect(fold(await readUntil(instance.session(id), () => true, { timeoutMs: 200 }).catch(() => []))).toEqual(
        fold([]),
      );
    } finally {
      await plain.close();
    }
  });
});

const submitsAsk = (writes: readonly StorageWrite[]) =>
  writes.some((write) => write.type === "submission" && write.value.requestId?.startsWith("deferred:") === true);

const makesCourier = (writes: readonly StorageWrite[]) =>
  writes.some((write) => write.type === "task" && write.value.kind === "runtime.ask");

async function parkWithoutAsking({ ports, session, runtime: both, bobs }: Awaited<ReturnType<typeof askSetup>>) {
  let deferred: DeferredContext<Ports> | undefined;
  ports.onStart = async (context) => {
    deferred = context;
  };
  await session.submit({ text: "Ask Bob", requestId: "1" });
  await readUntil(session, (event) => event.type === "reply:wait");
  const { requestId, replyTo } = deferred!;
  return () => both.get(responder, "bob").session(bobs).submit({ text: "Why?", requestId, replyTo });
}

describe("an ask cut off by a crash", () => {
  it("before the asking call parks starts its work again by the same request ID, and Bob holds one submission", async () => {
    const place = memoryPlace();
    const answer = held("Because.");
    const {
      faux,
      ports,
      deliveries,
      session,
      alice: first,
    } = await askSetup({
      place,
      host: crashingHost(place, parksOnReply),
    });
    const requests = scripts(faux, { alice: [askCall("Why?"), fauxAssistantMessage("Done.")], bob: [answer.step] });
    await session.submit({ text: "Ask Bob", requestId: "1" });
    await eventually(() => first.state === "failed");
    expect(ports.started).toHaveLength(1);

    const alice = runtime!.get(asker, "alice");
    await alice.open();
    await eventually(() => ports.started.length === 2);
    expect(ports.started[1]).toEqual(ports.started[0]);
    answer.release();
    await readUntil(alice.session(session.id), isRunEnd);
    expect(resultOf(requests.alice)).toMatchObject({ content: [{ type: "text", text: "Because." }] });
    expect(deliveries).toEqual(["applied"]);
    expect((await bobStored(place)).submissions).toBe(1);
  });

  it("between its courier and its submission is submitted by the courier, and the reply is delivered", async () => {
    const place = memoryPlace();
    const setup = await askSetup({ place, host: crashingHost(place, submitsAsk) });
    const { faux, deliveries, session, runtime: both } = setup;
    const requests = scripts(faux, {
      alice: [askCall("Why?"), fauxAssistantMessage("Done.")],
      bob: [fauxAssistantMessage("Because.")],
    });
    const askBob = await parkWithoutAsking(setup);
    const bob = both.get(responder, "bob");
    await expect(askBob()).rejects.toThrow("The process died");
    await eventually(() => bob.state === "failed");
    expect((await bobStored(place)).submissions).toBe(0);

    await both.get(responder, "bob").open();
    await readUntil(session, isRunEnd);
    expect(resultOf(requests.alice)).toMatchObject({ content: [{ type: "text", text: "Because." }] });
    expect(deliveries).toEqual(["applied"]);
    expect(await courierDone(place)).toEqual({ couriers: ["terminal"], submissions: 1 });
  });
});

// pi-durable runs a Session's commits one at a time in the order they come, and returns their outcomes in that order.
describe("an ask retried while it is under way", () => {
  it("is one ask for a retry that comes between the first try's courier and its submission", async () => {
    const place = memoryPlace();
    const hold = holdingHost(place, makesCourier);
    const setup = await askSetup({ place, host: hold.host });
    const requests = scripts(setup.faux, {
      alice: [askCall("Why?"), fauxAssistantMessage("Done.")],
      bob: [fauxAssistantMessage("Because.")],
    });
    const askBob = await parkWithoutAsking(setup);
    const first = askBob();
    const retry = askBob();
    await hold.reached;
    hold.release();
    expect(await retry).toEqual(await first);
    await readUntil(setup.session, isRunEnd);
    expect(resultOf(requests.alice)).toMatchObject({ content: [{ type: "text", text: "Because." }] });
    expect(setup.deliveries).toEqual(["applied"]);
    expect(replyFailures(setup.reports)).toEqual([]);
    expect(await courierDone(place)).toEqual({ couriers: ["terminal"], submissions: 1 });
  });

  it("is one ask for retries that come once the courier submitted it itself", async () => {
    const place = memoryPlace();
    const answer = held("Because.");
    const setup = await askSetup({ place, host: crashingHost(place, submitsAsk) });
    const requests = scripts(setup.faux, {
      alice: [askCall("Why?"), fauxAssistantMessage("Done.")],
      bob: [answer.step],
    });
    const askBob = await parkWithoutAsking(setup);
    const bob = setup.runtime.get(responder, "bob");
    await expect(askBob()).rejects.toThrow("The process died");
    await eventually(() => bob.state === "failed");
    await setup.runtime.get(responder, "bob").open();
    await answer.started;

    const [one, two] = await Promise.all([askBob(), askBob()]);
    expect(two).toEqual(one);
    answer.release();
    await readUntil(setup.session, isRunEnd);
    expect(resultOf(requests.alice)).toMatchObject({ content: [{ type: "text", text: "Because." }] });
    expect(setup.deliveries).toEqual(["applied"]);
    expect(replyFailures(setup.reports)).toEqual([]);
    expect(await courierDone(place)).toEqual({ couriers: ["terminal"], submissions: 1 });
  });
});
