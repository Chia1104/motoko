// An app extension's tool hooks driven through the runtime, on the faux provider. Each test expects what the README's
// "App extensions" says of them: a `beforeTool` hook rewrites a call's arguments once, and the call runs with that
// rewrite however often pi-durable runs the chain again, a restart included; it may block a call; and a sleep of its
// ends the call blocked, never at the gate, so nothing asks about it.

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

/** The tool search, and a deferred `weather` that goes out to the network, which the policy gates. */
function forecasting() {
  const cities: string[] = [];
  const weather = definePiTool({
    name: "weather",
    description: "The weather in a city",
    parameters: { type: "object", properties: { city: { type: "string" } } },
    deferred: true,
    async execute(args) {
      cities.push((args as { city: string }).city);
      return { output: [{ type: "text", text: "sunny" }] };
    },
  });
  const app: AppExtension[] = [
    { extension: createToolSearchExtension(), tier: () => "read" },
    { extension: defineExtension({ name: "forecast", tools: [weather] }), tier: () => "network" },
  ];
  return { app, cities };
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

/** The model loads the weather, asks for Taipei's, and answers. */
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

    // The approval woke the call, so the chain ran again and the hook rewrote the city anew; the call kept the first.
    expect(rewrites.length).toBeGreaterThan(1);
    expect(new Set(rewrites).size).toBe(rewrites.length);
    expect(cities).toEqual([rewrites[0]]);
    // The hook's other handlers run as the app wrote them.
    expect(ended).toBe(1);
    expect(weatherItem(items)).toMatchObject({ status: "ok" });
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

    // The decision woke the call and the hook gave nothing the second time: the call still runs with its rewrite.
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
