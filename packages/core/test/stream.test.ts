import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Wake } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { foldEvents } from "@chia1104/motoko-wire";

import { createAgentRuntime, defineAgent, defineTool } from "../src/index.ts";
import type { AgentHost, AgentRuntime } from "../src/index.ts";
import { toolJsonSchema, omitOfferedNulls } from "../src/json-schema.ts";

import { isRunEnd, memoryHost, readUntil } from "./helpers.ts";

const chat = defineAgent({ kind: "chat", instructions: "Chat.", tools: [] });

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("streaming", () => {
  it("streams a reply as deltas that the stored reply replaces, as a replay shows it", async () => {
    const faux = fauxProvider({ tokensPerSecond: 200, tokenSize: { min: 2, max: 2 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const text = "Streaming replies arrive in pieces before the whole reply is stored as one entry.";
    faux.setResponses([fauxAssistantMessage([fauxThinking("Let me think."), fauxText(text)])]);
    runtime = createAgentRuntime({
      agents: [chat],
      host: memoryHost(),
      models,
      ports: {},
      defaultModel: { provider: faux.provider.id, modelId: faux.getModel().id },
    });
    const instance = runtime.get(chat, "s");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "Talk", requestId: "t" });
    const items = await readUntil(session, isRunEnd);
    const events = items.map((item) => item.event);

    const deltas = events.filter((event) => event.type === "assistant:delta");
    expect(events.some((event) => event.type === "assistant:start")).toBe(true);
    expect(deltas.length).toBeGreaterThan(1);
    const streamed = deltas.flatMap((event) => (event.channel === "text" ? [event.delta] : [])).join("");
    expect(text.startsWith(streamed)).toBe(true);

    const view = foldEvents(events);
    expect(view.items).toMatchObject([
      { kind: "user", text: "Talk" },
      { kind: "assistant", text, thinking: "Let me think.", streaming: false },
    ]);
    // Without the stream events, the stored ones alone give the same view.
    const stored = events.filter((event) => event.type !== "assistant:start" && event.type !== "assistant:delta");
    expect(foldEvents(stored)).toEqual(view);
  });
});

describe("an alarm host", () => {
  it("arms before work and receives pi-durable's wake changes", async () => {
    const armed: Wake[] = [];
    const base = memoryHost();
    const host: AgentHost = {
      ...base,
      wake: {
        kind: "alarm",
        async arm(scope, wake) {
          expect(scope).toEqual({ kind: "chat", name: "do" });
          armed.push(wake);
        },
      },
    };
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    runtime = createAgentRuntime({
      agents: [chat],
      host,
      models,
      ports: {},
      defaultModel: { provider: faux.provider.id, modelId: faux.getModel().id },
    });
    const instance = runtime.get(chat, "do");
    const { id } = await instance.createSession();
    const before = armed.length;
    await instance.session(id).submit({ text: "x", requestId: "x" });
    // Armed active before the submit could start work.
    expect(armed[before]).toMatchObject({ active: true });
    await readUntil(instance.session(id), isRunEnd);
    await instance.resume();
    // pi-durable's own wake reports reach the host too, ending idle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(armed.at(-1)).toEqual({ active: false });
  });
});

describe("tool parameters", () => {
  it("offers optional parameters as nullable and drops a null the model sends", () => {
    const { schema, offered } = toolJsonSchema(
      "t",
      z.object({
        query: z.string().describe("What to find"),
        limit: z.number().optional().describe("At most"),
        tag: z.string().nullable().optional(),
        nested: z.object({ deep: z.boolean().optional() }),
      }),
    );
    expect(offered.properties).toMatchObject({
      query: { type: "string" },
      limit: { anyOf: [{ type: "number" }, { type: "null" }], description: "At most" },
      nested: { properties: { deep: { anyOf: [{ type: "boolean" }, { type: "null" }] } } },
    });
    expect(omitOfferedNulls(schema, { query: "q", limit: null, tag: null, nested: { deep: null } })).toEqual({
      query: "q",
      tag: null,
      nested: {},
    });
  });

  it("refuses parameters that are not an object", () => {
    expect(() =>
      defineTool({
        name: "bad",
        description: "",
        tier: "read",
        parameters: z.string(),
        execute: async () => ({ text: "" }),
      }),
    ).toThrow(/object of parameters/);
  });
});

describe("tool progress", () => {
  it("reaches clients as tool:update while the call runs, and the result replaces it", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const build = defineTool({
      name: "build",
      description: "Build the project",
      tier: "read",
      parameters: z.object({}),
      async execute(_args, { output, update }) {
        output("compiling...\n");
        await update({ step: 1 });
        // Progress is committed on a throttle; give it time to land before the result does.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { text: "built", details: { step: 2 } };
      },
    });
    const agent = defineAgent({ kind: "builder", instructions: "Build.", tools: [build] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("build", {}, { id: "b-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Built."),
    ]);
    runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      models,
      ports: {},
      defaultModel: { provider: faux.provider.id, modelId: faux.getModel().id },
    });
    const instance = runtime.get(agent, "b");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "Build", requestId: "b" });
    const items = await readUntil(session, isRunEnd);
    const events = items.map((item) => item.event);
    const updates = events.filter((event) => event.type === "tool:update");
    expect(updates.length).toBeGreaterThan(0);
    // Each update carries what changed since the last; folded, they give the running state.
    expect(updates.every((event) => event.toolCallId === "b-1")).toBe(true);
    expect(updates.some((event) => event.output === "compiling...\n")).toBe(true);
    expect(updates.some((event) => JSON.stringify(event.details) === JSON.stringify({ step: 1 }))).toBe(true);
    const running = foldEvents(events.slice(0, events.indexOf(updates.at(-1)!) + 1));
    expect(running.items.find((item) => item.kind === "tool")).toMatchObject({
      status: "running",
      progress: "compiling...\n",
      details: { step: 1 },
    });
    const tool = foldEvents(events).items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ status: "ok", details: { step: 2 } });
    expect(tool).not.toHaveProperty("progress");
  });
});
