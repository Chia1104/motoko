// Each test expects what the README's "Input metadata" says.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import type { StreamItem } from "@chia1104/motoko-wire";

import {
  createAgentRuntime,
  defineAgent,
  defineTool,
  InvalidRequestError,
  locateInputs,
  runInputs,
  scopeKey,
} from "../src/index.ts";
import type { AgentRuntime, AgentSession, RunInput, SubmitInput } from "../src/index.ts";

import {
  durableMemoryHost,
  eventually,
  expectEveryResumeFolds,
  fauxModels,
  follow,
  isRunEnd,
  memoryPlace,
  readUntil,
  runEnds,
} from "./helpers.ts";
import type { MemoryPlace } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

let holding = true;
const hold = defineTool({
  name: "hold",
  description: "Hold",
  tier: "read",
  replay: "safe",
  parameters: z.object({}),
  async execute(_args, { signal }) {
    if (!holding) return { text: "held" };
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { text: "stopped" };
  },
});

const agent = defineAgent({ kind: "writer", instructions: "You write.", tools: [hold] });

let seen: (readonly RunInput[])[] = [];

const userMessage = (text: string, timestamp: number): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});

const volatile = defineExtension({
  name: "volatile",
  hooks: [
    hook(GenerationTask, {
      async beforeRequest({ messages }, api, hookContext) {
        const inputs = await runInputs(api, hookContext);
        seen.push(inputs);
        const next = [...messages];
        for (const { index, at, metadata } of locateInputs(messages, inputs).toReversed()) {
          const text = metadata?.context;
          if (index !== undefined && typeof text === "string") next.splice(index + 1, 0, userMessage(text, at));
        }
        return { messages: next };
      },
    }),
  ],
});

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  holding = true;
  seen = [];
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function start(place: MemoryPlace) {
  const models = fauxModels();
  const runtime = createAgentRuntime({
    agents: [agent],
    host: durableMemoryHost(place),
    models: models.models,
    ports: {},
    defaultModel: models.model,
    extensionsFor: () => [{ extension: volatile }],
  });
  runtimes.push(runtime);
  return { faux: models.faux, runtime, instance: runtime.get(agent, "alice") };
}

async function storedInputs(place: MemoryPlace, session: AgentSession) {
  const storage = place.storages.get(scopeKey({ kind: agent.kind, name: "alice" }))!;
  const query = { conversationId: Number(session.id) as ConversationId, order: "ascending" as const };
  const { items } = await storage.scanEntries(query, 100, undefined, context);
  return items.flatMap(({ kind, data, model }) =>
    model?.[0]?.role === "user" ? [{ kind, data, text: textOf(model[0]) }] : [],
  );
}

function textOf(message: Message): string {
  if (message.role === "system") return "";
  const { content } = message;
  return typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

const users = (items: readonly StreamItem[]) =>
  items.flatMap((item) => (item.event.type === "user" ? [{ text: item.event.text, steer: item.event.steer }] : []));

const read = (messages: readonly Message[]) =>
  messages.filter((message) => message.role !== "system").map((message) => `${message.role}: ${textOf(message)}`);

const holdCall = () => fauxAssistantMessage(fauxToolCall("hold", {}, { id: "hold-1" }), { stopReason: "toolUse" });

describe("an input's metadata", () => {
  it("reaches the app's hook in every request of the run, in the same place after a restart, and is stored on the input alone", async () => {
    const place = memoryPlace();
    const requests: (readonly Message[])[] = [];

    const first = start(place);
    first.faux.setResponses([
      (request) => {
        requests.push(request.messages);
        return holdCall();
      },
    ]);
    const { id } = await first.instance.createSession();
    const session = first.instance.session(id);
    await session.submit({ text: "Write it", requestId: "1", metadata: { context: "drafts: A@3" } });
    await readUntil(session, (event) => event.type === "tool:start");
    await session.submit({
      text: "Use B too",
      requestId: "2",
      whenBusy: "steer",
      metadata: { context: "drafts: A@4, B@1" },
    });
    await first.runtime.close();
    expect(first.faux.state.callCount).toBe(1);

    holding = false;
    const second = start(place);
    second.faux.setResponses([
      (request) => {
        requests.push(request.messages);
        return fauxAssistantMessage("Done.");
      },
    ]);
    const reopened = second.instance.session(id);
    const live = follow(reopened);
    const items = await live.until((reached) => runEnds(reached) === 1);

    expect(requests.map(read)).toEqual([
      ["user: Write it", "user: drafts: A@3"],
      [
        "user: Write it",
        "user: drafts: A@3",
        "assistant: ",
        "toolResult: held",
        "user: Use B too",
        "user: drafts: A@4, B@1",
      ],
    ]);
    expect(requests[1]!.slice(0, requests[0]!.length)).toEqual(requests[0]);

    const [entry, steer] = seen.at(-1)!;
    expect(seen).toEqual([
      [{ entryId: entry!.entryId, at: entry!.at, steer: false, metadata: { context: "drafts: A@3" } }],
      [
        { entryId: entry!.entryId, at: entry!.at, steer: false, metadata: { context: "drafts: A@3" } },
        { entryId: steer!.entryId, at: steer!.at, steer: true, metadata: { context: "drafts: A@4, B@1" } },
      ],
    ]);

    expect(await storedInputs(place, reopened)).toEqual([
      { kind: "motoko.input", data: { metadata: { context: "drafts: A@3" } }, text: "Write it" },
      { kind: "motoko.steer", data: { metadata: { context: "drafts: A@4, B@1" } }, text: "Use B too" },
    ]);

    expect(users(items)).toEqual([
      { text: "Write it", steer: undefined },
      { text: "Use B too", steer: true },
    ]);
    expect(JSON.stringify(items)).not.toContain("drafts");
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    await expectEveryResumeFolds(reopened, items);
    await live.stop();
  });

  it("is stored on a plain input as `motoko.input` and on a steer as `motoko.steer`; without it nothing changes", async () => {
    const place = memoryPlace();
    const { faux, instance } = start(place);
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    faux.setResponses([
      async () => {
        await answered;
        return fauxAssistantMessage("First.");
      },
      fauxAssistantMessage("Both."),
      fauxAssistantMessage("Last."),
    ]);
    const session = instance.session((await instance.createSession()).id);
    const live = follow(session);

    await session.submit({ text: "A", requestId: "a" });
    await eventually(() => faux.state.callCount === 1);
    await session.submit({ text: "B", requestId: "b", metadata: { n: "b" } });
    await session.submit({ text: "C", requestId: "c", whenBusy: "steer", metadata: { n: "c" } });
    answer();
    await live.until((items) => runEnds(items) === 2);
    await session.submit({ text: "D", requestId: "d", whenBusy: "steer" });
    const items = await live.until((reached) => runEnds(reached) === 3);

    expect(await storedInputs(place, session)).toEqual([
      { kind: "pi.user", data: undefined, text: "A" },
      { kind: "motoko.input", data: { metadata: { n: "b" } }, text: "B" },
      { kind: "motoko.steer", data: { metadata: { n: "c" } }, text: "C" },
      { kind: "motoko.steer", data: undefined, text: "D" },
    ]);
    expect(users(items)).toEqual([
      { text: "A", steer: undefined },
      { text: "B", steer: undefined },
      { text: "C", steer: undefined },
      { text: "D", steer: undefined },
    ]);

    const [[a], [b, c], [d]] = seen as [RunInput[], RunInput[], RunInput[]];
    expect(seen).toEqual([
      [{ entryId: a!.entryId, at: a!.at, steer: false }],
      [
        { entryId: b!.entryId, at: b!.at, steer: false, metadata: { n: "b" } },
        { entryId: c!.entryId, at: b!.at, steer: false, metadata: { n: "c" } },
      ],
      [{ entryId: d!.entryId, at: d!.at, steer: false }],
    ]);
    expect(c!.entryId).toBeGreaterThan(b!.entryId);
    await expectEveryResumeFolds(session, items);
    await live.stop();
  });

  it("reaches a continue's hook with the inputs of the failed run it carries on", async () => {
    holding = false;
    const { faux, instance } = start(memoryPlace());
    faux.setResponses([holdCall(), fauxAssistantMessage("Done.")]);
    const session = instance.session((await instance.createSession({ maxTurns: 1 })).id);
    const live = follow(session);
    await session.submit({ text: "Write it", requestId: "1", metadata: { context: "drafts: A@3" } });
    await live.until((items) => runEnds(items) === 1);
    await session.continue({ requestId: "2" });
    await live.until((items) => runEnds(items) === 2);
    await live.stop();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[1]).toEqual([expect.objectContaining({ steer: false, metadata: { context: "drafts: A@3" } })]);
  });

  it("is a JSON object, which an ask takes none of; `submit` refuses another, admitting nothing", async () => {
    const place = memoryPlace();
    const { faux, instance } = start(place);
    const session = instance.session((await instance.createSession()).id);
    const refused: unknown[] = [null, [], "drafts", 1, { at: new Date(0) }, { n: Number.NaN }, { missing: undefined }];
    for (const metadata of refused) {
      const input = { text: "Hi", requestId: "1", metadata } as unknown as SubmitInput;
      await expect(session.submit(input), JSON.stringify(metadata)).rejects.toBeInstanceOf(InvalidRequestError);
    }
    const replyTo = { scope: { kind: "writer", name: "bob" }, sessionId: "1", toolCallId: "c-1", token: "t" };
    const ask: SubmitInput = { text: "Hi", requestId: "1", replyTo, metadata: { n: 1 } };
    await expect(session.submit(ask)).rejects.toThrow("An ask takes no `metadata`");

    expect(await storedInputs(place, session)).toEqual([]);
    expect(faux.state.callCount).toBe(0);
    const metadata: JsonObject = { nested: { list: [1, "two", null, true] } };
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    await session.submit({ text: "Hi", requestId: "1", metadata });
    await readUntil(session, isRunEnd);
    expect(seen).toEqual([[expect.objectContaining({ metadata })]]);
  });
});

describe("locateInputs", () => {
  const answer = fauxAssistantMessage("Done.");

  it("gives inputs that share a time that time's messages in entry order", () => {
    const messages = [userMessage("A", 1), answer, userMessage("B", 5), userMessage("C", 5)];
    const b: RunInput = { entryId: 3, at: 5, steer: false, metadata: { n: "b" } };
    const c: RunInput = { entryId: 4, at: 5, steer: false, metadata: { n: "c" } };

    expect(locateInputs(messages, [b, c])).toEqual([
      { entryId: 3, at: 5, steer: false, metadata: { n: "b" }, index: 2 },
      { entryId: 4, at: 5, steer: false, metadata: { n: "c" }, index: 3 },
    ]);
  });

  it("gives an input whose message the request does not hold no index, and finds the inputs before it", () => {
    const messages = [userMessage("A", 1), answer, userMessage("C", 3)];
    const inputs: RunInput[] = [
      { entryId: 1, at: 1, steer: false },
      { entryId: 3, at: 2, steer: true },
      { entryId: 5, at: 3, steer: true },
    ];

    expect(locateInputs(messages, inputs)).toEqual([
      { entryId: 1, at: 1, steer: false, index: 0 },
      { entryId: 3, at: 2, steer: true, index: undefined },
      { entryId: 5, at: 3, steer: true, index: 2 },
    ]);
  });

  it("takes the run's message, not an earlier run's of the same time", () => {
    const messages = [userMessage("Earlier", 5), answer, userMessage("Now", 5)];

    expect(locateInputs(messages, [{ entryId: 7, at: 5, steer: false }])).toEqual([
      { entryId: 7, at: 5, steer: false, index: 2 },
    ]);
  });
});
