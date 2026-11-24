// A nested call, one a tool makes through pi-durable's `executeTool()`, driven through the runtime on the faux provider
// with pi-durable's real code mode: its script runs in pi-codemode's Node sandbox. Each test expects what the README's
// "Durable approval" says of a nested call the gate holds: it is asked about under the call that made it, `approve()`
// decides it, through a restart, and the script carries on with its result.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, AgentWireEventOf, StreamItem, ToolItem } from "@chia1104/motoko-wire";

import { createAgentRuntime, defineAgent, defineTool } from "../src/index.ts";
import type { AgentHost, AgentRuntime, ToolContext } from "../src/index.ts";

import {
  durableMemoryHost,
  eventually,
  expectEveryResumeFolds,
  fauxModels,
  follow,
  isRunEnd,
  memoryPlace,
  readUntil,
  settledTypes,
} from "./helpers.ts";

interface Ports {
  readonly deleted: string[];
}

const remove = defineTool({
  name: "remove",
  description: "Delete a note",
  tier: "write",
  parameters: z.object({ key: z.string() }),
  async execute({ key }, { ports }: ToolContext<Ports>) {
    ports.deleted.push(key);
    return { text: `deleted ${key}` };
  },
});

const notes = defineAgent<Ports>({
  kind: "notes",
  instructions: "You keep notes.",
  tools: [remove],
  policy: { requiresApproval: ["write"] },
});

const sandbox = new CodemodeSandbox();
afterAll(async () => {
  await sandbox.close();
});

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

/**
 * A runtime whose instances run code mode, at tier `exec`, which the notes agent's policy does not gate. With
 * `closeIdleAfterMs`, it closes idle instances.
 */
function start(host: AgentHost, deleted: string[], models = fauxModels(), closeIdleAfterMs?: number) {
  runtime = createAgentRuntime({
    agents: [notes],
    host,
    models: models.models,
    ports: { deleted },
    defaultModel: models.model,
    extensionsFor: () => [{ extension: createCodemodeExtension({ sandbox, models: false }), tier: () => "exec" }],
    ...(closeIdleAfterMs !== undefined && { closeIdleAfterMs }),
  });
  return { faux: models.faux, instance: runtime.get(notes, "alice") };
}

/** The model runs a script that deletes note `a`, then answers. */
const deleteByScript = [
  fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(await tools.remove({ key: "a" }));' }, { id: "cm-1" }), {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("Deleted a."),
];

type Question = AgentWireEventOf<"approval:request">;
const isAsked = (event: AgentWireEvent) => event.type === "approval:request";
const questions = (items: readonly StreamItem[]) =>
  items.flatMap(({ event }) => (event.type === "approval:request" ? [event] : []));
const codemodeItem = (items: readonly StreamItem[]) =>
  foldEvents(items.map((item) => item.event)).items.find(
    (item): item is ToolItem => item.kind === "tool" && item.toolCallId === "cm-1",
  );

describe("a nested call the gate holds", () => {
  it("is asked about under the script's call, decided after a restart, and the script carries on", async () => {
    const place = memoryPlace();
    const models = fauxModels();
    const deleted: string[] = [];
    let { faux, instance } = start(durableMemoryHost(place), deleted, models);
    faux.setResponses(deleteByScript);
    const { id } = await instance.createSession();
    let reader = follow(instance.session(id));
    await instance.session(id).submit({ text: "Delete a", requestId: "1" });
    const live = [...(await reader.until((items) => items.some(({ event }) => isAsked(event))))];
    const [question] = questions(live);
    expect(question).toEqual<Question>({
      type: "approval:request",
      toolCallId: expect.stringMatching(/^cm-1\//) as string,
      toolName: "remove",
      tier: "write",
      args: { key: "a" },
      parentToolCallId: "cm-1",
    });
    // The script's call runs on, waiting on what it made; the run waits for the operator.
    expect(foldEvents(live.map((item) => item.event))).toMatchObject({
      status: "awaiting_approval",
      pendingApprovals: [question!.toolCallId],
    });
    expect(codemodeItem(live)).toMatchObject({
      status: "running",
      nestedApprovals: [{ toolCallId: question!.toolCallId, toolName: "remove", tier: "write", args: { key: "a" } }],
    });
    expect(deleted).toEqual([]);
    // A client that resumes while the call waits, from any cursor, folds the same view.
    await expectEveryResumeFolds(instance.session(id), live);
    await reader.stop();
    await runtime!.close();

    ({ instance } = start(durableMemoryHost(place), deleted, models));
    reader = follow(instance.session(id));
    // A client arriving after the restart is asked the same, while the call still waits.
    await reader.until((items) => questions(items).length > 0);
    expect(questions(reader.items)).toEqual([question]);
    expect(await instance.session(id).approve([{ toolCallId: question!.toolCallId, approved: true }])).toEqual([
      { toolCallId: question!.toolCallId, outcome: "applied" },
    ]);
    const items = [...(await reader.until((read) => read.some(({ event }) => isRunEnd(event))))];

    expect(deleted).toEqual(["a"]);
    // The decision went out as the nested call moved on, before the script's call ended.
    expect(settledTypes(items)).toEqual([
      "run:start",
      "user",
      "assistant:end",
      "tool:start",
      "approval:request",
      "approval:resolved",
      "tool:end",
      "assistant:end",
      "run:end",
    ]);
    expect(items.find(({ event }) => event.type === "approval:resolved")?.event).toEqual({
      type: "approval:resolved",
      toolCallId: question!.toolCallId,
      approved: true,
    });
    const end = items.find(({ event }) => event.type === "tool:end" && event.toolCallId === "cm-1")?.event;
    expect(end).toMatchObject({ type: "tool:end", toolName: "codemode", status: "ok" });
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    // The nested question ended with the script's call.
    expect(codemodeItem(items)).not.toHaveProperty("nestedApprovals");
    expect(foldEvents(items.map((item) => item.event))).toMatchObject({ status: "idle", pendingApprovals: [] });
    await expectEveryResumeFolds(instance.session(id), items);
    await reader.stop();
  });

  it("declined, fails the script's call with the operator's words, and does not run", async () => {
    const deleted: string[] = [];
    const { faux, instance } = start(durableMemoryHost(), deleted);
    faux.setResponses(deleteByScript);
    const { id } = await instance.createSession();
    const reader = follow(instance.session(id));
    await instance.session(id).submit({ text: "Delete a", requestId: "1" });
    await reader.until((items) => questions(items).length > 0);
    const [question] = questions(reader.items);
    await instance.session(id).approve([{ toolCallId: question!.toolCallId, approved: false, comment: "Keep a." }]);
    const items = [...(await reader.until((read) => read.some(({ event }) => isRunEnd(event))))];

    expect(deleted).toEqual([]);
    expect(items.find(({ event }) => event.type === "approval:resolved")?.event).toEqual({
      type: "approval:resolved",
      toolCallId: question!.toolCallId,
      approved: false,
      comment: "Keep a.",
    });
    expect(codemodeItem(items)).toMatchObject({
      status: "error",
      error: expect.stringContaining("The operator declined this call: Keep a.") as string,
    });
    expect(codemodeItem(items)).not.toHaveProperty("nestedApprovals");
    await expectEveryResumeFolds(instance.session(id), items);
    await reader.stop();
  });

  it("keeps its instance open while it waits, since the script's call awaits it", async () => {
    const idle = 40;
    const deleted: string[] = [];
    const { faux, instance } = start(durableMemoryHost(), deleted, fauxModels(), idle);
    faux.setResponses(deleteByScript);
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Delete a", requestId: "1" });
    const [question] = questions(await readUntil(instance.session(id), isAsked));
    await new Promise((resolve) => setTimeout(resolve, idle * 5));
    expect(instance.state).toBe("open");

    await instance.session(id).approve([{ toolCallId: question!.toolCallId, approved: true }]);
    await readUntil(instance.session(id), isRunEnd);
    await eventually(() => instance.state === "dormant");
    expect(deleted).toEqual(["a"]);
  });
});
