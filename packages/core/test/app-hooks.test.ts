// Each test expects what the README's "App extensions" and "Durable approval" say.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool as definePiTool, hook, ToolTask } from "@earendil-works/pi-durable";
import type { JsonObject, ToolHooks } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, StreamItem, ToolItem } from "@chia1104/motoko-wire";

import { createAgentRuntime, defineAgent } from "../src/index.ts";
import type { AgentHost, AgentRuntime, AppExtension } from "../src/index.ts";

import { durableMemoryHost, fauxModels, isRunEnd, memoryHost, memoryPlace, readUntil } from "./helpers.ts";

const desk = defineAgent({
  kind: "desk",
  instructions: "You run the desk.",
  tools: [],
  policy: { requiresApproval: ["network"] },
});

function forecasting(executionMode?: "sequential") {
  const cities: string[] = [];
  const ran: JsonObject[] = [];
  const weather = definePiTool({
    name: "weather",
    description: "The weather in a city",
    parameters: { type: "object", properties: { city: { type: "string" }, units: { type: "string" } } },
    deferred: true,
    ...(executionMode !== undefined && { executionMode }),
    async execute(args) {
      cities.push((args as { city: string }).city);
      ran.push(args as JsonObject);
      return { output: [{ type: "text", text: "sunny" }] };
    },
  });
  const app: AppExtension[] = [
    { extension: createToolSearchExtension(), tier: () => "read" },
    { extension: defineExtension({ name: "forecast", tools: [weather] }), tier: () => "network" },
  ];
  return { app, cities, ran };
}

const hooks = (name: string, handlers: Partial<ToolHooks>): AppExtension => ({
  extension: defineExtension({ name, hooks: [hook(ToolTask, handlers)] }),
});

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

function start(extensions: readonly AppExtension[], host: AgentHost, models = fauxModels()) {
  runtime = createAgentRuntime({
    agents: [desk],
    host,
    models: models.models,
    ports: {},
    defaultModel: models.model,
    extensionsFor: () => extensions,
  });
  return { faux: models.faux, instance: runtime.get(desk, "alice") };
}

const call = (name: string, args: JsonObject, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });

const weatherInTaipei = [
  call("tool_search", { query: "weather" }, "ts-1"),
  call("weather", { city: "Taipei" }, "w-1"),
  fauxAssistantMessage("Sunny in Taipei."),
];

const isAsked = (event: AgentWireEvent) => event.type === "approval:request";
const asked = (items: readonly StreamItem[]) => items.filter(({ event }) => isAsked(event));
const weatherItem = (items: readonly StreamItem[]) =>
  foldEvents(items.map((item) => item.event)).items.find(
    (item): item is ToolItem => item.kind === "tool" && item.toolCallId === "w-1",
  );

describe("app hooks", () => {
  it("runs a call with an app hook's first rewrite of its arguments, through a restart and a decision", async () => {
    const { app, cities } = forecasting();
    const rewrites: string[] = [];
    let ended = 0;
    const stamp = hooks("stamp", {
      beforeTool(call) {
        if (call.name !== "weather") return undefined;
        rewrites.push(`${String(call.arguments.city)} at ${Date.now()}, pass ${rewrites.length + 1}`);
        return { arguments: { city: rewrites.at(-1)! } };
      },
      afterTool(call, result) {
        if (call.name === "weather") ended += 1;
        return result;
      },
    });
    const place = memoryPlace();
    const models = fauxModels();
    let { faux, instance } = start([...app, stamp], durableMemoryHost(place), models);
    faux.setResponses(weatherInTaipei);
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Weather?", requestId: "1" });
    await readUntil(instance.session(id), isAsked);
    await runtime!.close();

    ({ instance } = start([...app, stamp], durableMemoryHost(place), models));
    await instance.session(id).approve([{ toolCallId: "w-1", approved: true }]);
    const items = await readUntil(instance.session(id), isRunEnd);

    expect(rewrites.length).toBeGreaterThan(1);
    expect(new Set(rewrites).size).toBe(rewrites.length);
    expect(cities).toEqual([rewrites[0]]);
    expect(ended).toBe(1);
    expect(weatherItem(items)).toMatchObject({ status: "ok" });
  });

  it("asks about a call with an app hook's rewrite, which it runs with, live, after a restart and from the start", async () => {
    const { app, cities } = forecasting();
    let passes = 0;
    const stamp = hooks("stamp", {
      beforeTool(call) {
        if (call.name !== "weather") return undefined;
        passes += 1;
        return { arguments: { city: `${String(call.arguments.city)} at ${Date.now()}, pass ${passes}` } };
      },
    });
    const place = memoryPlace();
    const models = fauxModels();
    let { faux, instance } = start([...app, stamp], durableMemoryHost(place), models);
    faux.setResponses(weatherInTaipei);
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Weather?", requestId: "1" });
    const [live] = asked(await readUntil(instance.session(id), isAsked));
    await runtime!.close();

    ({ instance } = start([...app, stamp], durableMemoryHost(place), models));
    const [waiting] = asked(await readUntil(instance.session(id), isAsked));
    await instance.session(id).approve([{ toolCallId: "w-1", approved: true }]);
    await readUntil(instance.session(id), isRunEnd);
    const replayed = await readUntil(instance.session(id), isRunEnd);
    const [again] = asked(replayed);

    expect(passes).toBeGreaterThan(1);
    expect(cities).toEqual([expect.stringMatching(/^Taipei at \d+, pass 1$/)]);
    const question = { type: "approval:request", toolCallId: "w-1", args: { city: cities[0] } };
    expect([live?.event, waiting?.event, again?.event]).toEqual([
      expect.objectContaining(question),
      expect.objectContaining(question),
      expect.objectContaining(question),
    ]);
    expect(
      replayed.find(({ event }) => event.type === "tool:start" && event.toolCallId === "w-1")?.event,
    ).toMatchObject({ args: { city: "Taipei" } });
    expect(weatherItem(replayed)).toMatchObject({ status: "ok", args: { city: cities[0] } });
  });

  it("keeps an app hook's rewrite when the hook leaves a later run of the chain alone", async () => {
    const { app, cities } = forecasting();
    let passes = 0;
    const once = hooks("once", {
      beforeTool(call) {
        if (call.name !== "weather") return undefined;
        passes += 1;
        return passes === 1 ? { arguments: { city: "Tainan" } } : undefined;
      },
    });
    const { faux, instance } = start([...app, once], memoryHost());
    faux.setResponses(weatherInTaipei);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Weather?", requestId: "1" });
    await readUntil(session, isAsked);
    await session.approve([{ toolCallId: "w-1", approved: true }]);
    await readUntil(session, isRunEnd);

    expect(passes).toBeGreaterThan(1);
    expect(cities).toEqual(["Tainan"]);
  });

  it.each([
    { what: "a sleep", decision: { sleep: { until: Date.now() + 60_000 } } },
    {
      what: "a sleep with arguments",
      decision: { arguments: { city: "Tainan" }, sleep: { until: Date.now() + 60_000 } },
    },
  ])("ends a call blocked when an app hook answers $what, and asks nothing", async ({ decision }) => {
    const { app, cities } = forecasting();
    const wait = hooks("wait", { beforeTool: (call) => (call.name === "weather" ? decision : undefined) });
    const { faux, instance } = start([...app, wait], memoryHost());
    faux.setResponses(weatherInTaipei);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Weather?", requestId: "1" });
    const items = await readUntil(session, isRunEnd);

    expect(asked(items)).toEqual([]);
    expect(weatherItem(items)).toMatchObject({
      status: "error",
      error: expect.stringContaining("Tool call blocked: an app hook cannot make a call wait (app extension `wait`)"),
    });
    expect(cities).toEqual([]);
  });

  it("ends a call an app hook blocks with the hook's reason, and asks nothing", async () => {
    const { app, cities } = forecasting();
    const deny = hooks("deny", {
      beforeTool: (call) => (call.name === "weather" ? { block: "no forecasts today" } : undefined),
    });
    const { faux, instance } = start([...app, deny], memoryHost());
    faux.setResponses(weatherInTaipei);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Weather?", requestId: "1" });
    const items = await readUntil(session, isRunEnd);

    expect(asked(items)).toEqual([]);
    expect(weatherItem(items)).toMatchObject({
      status: "error",
      error: expect.stringContaining("Tool call blocked: no forecasts today"),
    });
    expect(cities).toEqual([]);
  });
});

function holding(callId: string, rewrite?: JsonObject) {
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const extension = hooks("hold", {
    async beforeTool(call) {
      if (call.id !== callId) return undefined;
      reach();
      await released;
      return rewrite === undefined ? undefined : { arguments: rewrite };
    },
  });
  return { extension, reached, release };
}

function twoCities(second: JsonObject) {
  let read: unknown;
  const responses = [
    call("tool_search", { query: "weather" }, "ts-1"),
    fauxAssistantMessage(
      [fauxToolCall("weather", { city: "Taipei" }, { id: "w-1" }), fauxToolCall("weather", second, { id: "w-2" })],
      { stopReason: "toolUse" },
    ),
    (request: { messages: readonly unknown[] }) => {
      read = request.messages.at(-1);
      return fauxAssistantMessage("Done.");
    },
  ];
  return { responses, read: () => read };
}

describe("a call approved before it parked", () => {
  it("ends blocked when an app hook rewrites it after the approval, and the model reads why", async () => {
    const { app, cities } = forecasting("sequential");
    const hold = holding("w-2", { city: "Kaohsiung" });
    const { faux, instance } = start([...app, hold.extension], memoryHost());
    const model = twoCities({ city: "Tainan" });
    faux.setResponses(model.responses);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Weather?", requestId: "1" });
    await readUntil(session, isAsked);
    await session.approve([{ toolCallId: "w-1", approved: true }]);
    await hold.reached;
    expect(await session.approve([{ toolCallId: "w-2", approved: true }])).toEqual([
      { toolCallId: "w-2", outcome: "applied" },
    ]);
    hold.release();
    await readUntil(session, isRunEnd);

    expect(cities).toEqual(["Taipei"]);
    expect(model.read()).toMatchObject({
      role: "toolResult",
      toolCallId: "w-2",
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("The call's arguments changed after the operator was asked about it."),
        },
      ],
    });
  });

  it("runs when no app hook rewrites it, with the model's arguments as the tool coerces them", async () => {
    const { app, cities, ran } = forecasting("sequential");
    const hold = holding("w-2");
    const { faux, instance } = start([...app, hold.extension], memoryHost());
    const model = twoCities({ city: "Tainan", units: null });
    faux.setResponses(model.responses);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Weather?", requestId: "1" });
    await readUntil(session, isAsked);
    await session.approve([{ toolCallId: "w-1", approved: true }]);
    await hold.reached;
    await session.approve([{ toolCallId: "w-2", approved: true }]);
    hold.release();
    await readUntil(session, isRunEnd);

    expect(cities).toEqual(["Taipei", "Tainan"]);
    expect(ran.at(-1)).toEqual({ city: "Tainan" });
    expect(model.read()).toMatchObject({ role: "toolResult", toolCallId: "w-2", isError: false });
  });
});
