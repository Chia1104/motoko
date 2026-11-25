import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

import { createAgentRuntime, defineAgent, defineDelegate, SessionOwnedError } from "../src/index.ts";
import type { AgentRuntime, AgentRuntimeOptions } from "../src/index.ts";

import {
  committedOnly,
  expectEveryResumeFolds,
  fauxModels,
  follow,
  isRunEnd,
  memoryHost,
  readUntil,
} from "./helpers.ts";

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

const agent = defineAgent({ kind: "chat", instructions: "You chat.", tools: [] });

const settings: AgentRuntimeOptions<unknown>["settings"] = {
  compaction: { keepRecentTokens: 1 },
  retry: { enabled: false },
};

function setup() {
  const { faux, models, model } = fauxModels();
  runtime = createAgentRuntime({
    agents: [agent],
    host: memoryHost(),
    models,
    ports: {},
    defaultModel: model,
    settings,
  });
  return { faux, instance: runtime.get(agent, "c") };
}

async function chatted() {
  const { faux, instance } = setup();
  const session = instance.session((await instance.createSession()).id);
  faux.setResponses([fauxAssistantMessage("Hello."), fauxAssistantMessage("Apples are red.")]);
  await session.submit({ text: "Hi", requestId: "1" });
  await session.submit({ text: "What colour are apples?", requestId: "2" });
  await readUntil(session, (_event, items) => items.filter((item) => isRunEnd(item.event)).length === 2);
  return { faux, instance, session };
}

const types = (items: readonly StreamItem[]) => items.map((item) => item.event.type);
const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));
const isCompactionEnd = (event: AgentWireEvent) => event.type === "compaction:end";

describe("compacting a session", () => {
  it("summarizes an idle session's older messages: the stream shows it start, the summary, and its end", async () => {
    const { faux, session } = await chatted();
    let summarized: string | undefined;
    faux.setResponses([
      (context) => {
        summarized = JSON.stringify(context.messages);
        return fauxAssistantMessage("The user greeted and asked about apples.");
      },
    ]);
    const reader = follow(session);
    await reader.until((items) => items.filter((item) => isRunEnd(item.event)).length === 2);

    await session.compact({ instructions: "Keep the colours." });
    const items = await reader.until((read) => read.some((item) => isCompactionEnd(item.event)));
    await reader.stop();
    const compaction = items.slice(items.findIndex((item) => item.event.type === "compaction:start"));
    expect(compaction.map((item) => item.event)).toEqual([
      { type: "compaction:start", reason: "manual" },
      {
        type: "session:compacted",
        messageId: expect.any(String),
        summary: "The user greeted and asked about apples.",
        at: expect.any(Number),
      },
      { type: "compaction:end" },
    ]);
    expect(summarized).toContain("Keep the colours.");
    const view = fold(items);
    expect(view.compaction).toBeUndefined();
    expect(view.items.at(-1)).toMatchObject({
      kind: "compaction",
      summary: "The user greeted and asked about apples.",
    });
    expect(fold(await readUntil(session, (event) => event.type === "session:compacted"))).toEqual(view);
  });

  it("shows why a compaction failed, until one succeeds", async () => {
    const { faux, session } = await chatted();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })]);
    const reader = follow(session);
    await session.compact();
    const items = await reader.until((read) => read.some((item) => isCompactionEnd(item.event)));
    expect(items.find((item) => isCompactionEnd(item.event))?.event).toEqual({
      type: "compaction:end",
      error: "Summarization failed: overloaded",
    });
    expect(fold(items).compaction).toEqual({ status: "failed", error: "Summarization failed: overloaded" });
    expect(types(items)).not.toContain("session:compacted");
    const late = await readUntil(session, isCompactionEnd);
    expect(fold(late).compaction).toEqual(fold(items).compaction);

    faux.setResponses([fauxAssistantMessage("A summary.")]);
    await session.compact();
    await reader.until((read) => read.filter((item) => isCompactionEnd(item.event)).length === 2);
    await reader.stop();
    expect(fold(reader.items).compaction).toBeUndefined();
  });

  it("folds the same view for a client resuming from any cursor, during the compaction and after it", async () => {
    const { faux, session } = await chatted();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: FauxResponseStep = async () => {
      await released;
      return fauxAssistantMessage("A summary.");
    };
    faux.setResponses([held]);
    const reader = follow(session);
    await reader.until((items) => items.filter((item) => isRunEnd(item.event)).length === 2);
    const before = reader.items.at(-1)!.cursor;

    await session.compact();
    await reader.until((items) => items.some((item) => item.event.type === "compaction:start"));
    const during = fold(reader.items);
    expect(during.compaction).toEqual({ status: "running", reason: "manual" });
    const caughtUp = await readUntil(
      session,
      (_event, items) => items.some((item) => item.event.type === "compaction:start"),
      { from: committedOnly(before) },
    );
    expect(
      fold([...reader.items.slice(0, reader.items.findIndex((item) => item.cursor === before) + 1), ...caughtUp]),
    ).toEqual(during);

    release();
    await reader.until((items) => items.some((item) => isCompactionEnd(item.event)));
    await expectEveryResumeFolds(session, reader.items);
    await reader.stop();
  });

  it("is refused for a child session: its delegate's call owns its context", async () => {
    const sub = defineAgent({ kind: "sub", instructions: "You help.", tools: [] });
    const parentAgent = defineAgent({
      kind: "parent",
      instructions: "You delegate.",
      tools: [defineDelegate({ name: "ask", description: "Ask the helper", tier: "read", agent: sub })],
    });
    const { faux, models, model } = fauxModels();
    runtime = createAgentRuntime({ agents: [parentAgent], host: memoryHost(), models, ports: {}, defaultModel: model });
    const instance = runtime.get(parentAgent, "p");
    const parent = instance.session((await instance.createSession()).id);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask", { task: "Help" }, { id: "d-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Helped."),
      fauxAssistantMessage("Done."),
    ]);
    await parent.submit({ text: "Go", requestId: "1" });
    const items = await readUntil(parent, isRunEnd);
    const end = items.find((item) => item.event.type === "tool:end")?.event;
    const childId = (end as { details?: { sessionId?: string } } | undefined)?.details?.sessionId;
    expect(childId).toBeDefined();
    await expect(instance.session(childId!).compact()).rejects.toBeInstanceOf(SessionOwnedError);
  });
});
