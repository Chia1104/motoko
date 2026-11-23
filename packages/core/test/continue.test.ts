import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

import { callErrorOf, createAgentRuntime, defineAgent, defineTool, runCall, SessionBusyError } from "../src/index.ts";
import type { AgentRuntime } from "../src/index.ts";

import { expectEveryResumeFolds, fauxModels, follow, memoryHost, readUntil, runEnds, settledTypes } from "./helpers.ts";

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

/** Released by the test: a call of `gate` runs until then. */
let opened: Promise<void> = Promise.resolve();

const lookup = defineTool({
  name: "lookup",
  description: "Look up a note",
  tier: "read",
  parameters: z.object({ key: z.string() }),
  async execute({ key }) {
    return { text: `note ${key}: apples` };
  },
});

const gate = defineTool({
  name: "gate",
  description: "Wait for the gate",
  tier: "read",
  parameters: z.object({}),
  async execute() {
    await opened;
    return { text: "through" };
  },
});

const agent = defineAgent({ kind: "notes", instructions: "You keep notes.", tools: [lookup, gate] });

function setup() {
  const { faux, models, model } = fauxModels();
  runtime = createAgentRuntime({ agents: [agent], host: memoryHost(), models, ports: {}, defaultModel: model });
  return { faux, instance: runtime.get(agent, "n") };
}

/** A promise and the function that resolves it. */
function door() {
  let open: () => void = () => undefined;
  const shut = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { shut, open };
}

const call = (name: string, id: string, args: Record<string, string> = {}) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));
const runEndsOf = (items: readonly StreamItem[]) =>
  items.filter((item) => item.event.type === "run:end").map((item) => item.event);
const turnLimit: AgentWireEvent = { type: "run:end", reason: "error", code: "turn_limit", error: "1 turn" };

/** A session whose first run reached its turn limit of one tool round, read by a client from its start. */
async function turnLimited() {
  const { faux, instance } = setup();
  const session = instance.session((await instance.createSession({ maxTurns: 1 })).id);
  faux.setResponses([call("lookup", "l-1", { key: "a" })]);
  const reader = follow(session);
  await session.submit({ text: "What is a?", requestId: "1" });
  await reader.until((items) => runEnds(items) === 1);
  return { faux, instance, session, reader };
}

describe("continuing a run", () => {
  it("carries on a run that reached its turn limit, from its results, to an answer", async () => {
    const { faux, session, reader } = await turnLimited();
    expect(runEndsOf(reader.items)).toEqual([turnLimit]);
    let readLast: string | undefined;
    faux.setResponses([
      (context) => {
        readLast = context.messages.at(-1)?.role;
        return fauxAssistantMessage("a is apples.");
      },
    ]);

    expect(await session.continue({ requestId: "c-1" })).toEqual({ submissionId: expect.any(String) });
    await reader.until((items) => runEnds(items) === 2);
    await reader.stop();
    // The model read the context as the failed run left it, ending in the round's results.
    expect(readLast).toBe("toolResult");
    const second = reader.items.slice(reader.items.findIndex((item) => item.event.type === "run:end") + 1);
    expect(settledTypes(second)).toEqual(["run:start", "assistant:end", "run:end"]);
    expect(runEndsOf(reader.items)).toEqual([turnLimit, { type: "run:end", reason: "done" }]);
    const view = fold(reader.items);
    expect(view.items).toMatchObject([
      { kind: "user", text: "What is a?" },
      { kind: "assistant", stopReason: "toolUse" },
      { kind: "tool", toolCallId: "l-1", status: "ok" },
      { kind: "notice", reason: "error", code: "turn_limit" },
      { kind: "assistant", text: "a is apples." },
    ]);
    // History shows the two runs too: a client that replays the session folds the same view.
    expect(fold(await readUntil(session, (_event, items) => runEnds(items) === 2))).toEqual(view);
  });

  it("folds the same view for a client resuming from any cursor, inside the continued run too", async () => {
    const { faux, session, reader } = await turnLimited();
    await session.configure({ maxTurns: null });
    faux.setResponses([call("lookup", "l-2", { key: "b" }), fauxAssistantMessage("Both are apples.")]);
    await session.continue({ requestId: "c-1" });
    await reader.until((items) => runEnds(items) === 2);
    await expectEveryResumeFolds(session, reader.items);
    await reader.stop();
  });

  it("is refused while a run is going, writing nothing", async () => {
    const { faux, instance } = setup();
    const session = instance.session((await instance.createSession()).id);
    const reply = door();
    const held: FauxResponseStep = async () => {
      await reply.shut;
      return fauxAssistantMessage("Done.");
    };
    faux.setResponses([held]);
    await session.submit({ text: "Go", requestId: "1" });
    await readUntil(session, (event) => event.type === "user");

    await expect(session.continue({ requestId: "c-1" })).rejects.toBeInstanceOf(SessionBusyError);
    const refused = await runCall(instance, {
      method: "continue",
      params: { sessionId: session.id, requestId: "c-2" },
    }).catch((error: unknown) => error);
    expect(callErrorOf(refused)).toMatchObject({ code: "session_busy" });
    reply.open();
    const items = await readUntil(session, (_event, read) => runEnds(read) === 1);
    expect(items.filter((item) => item.event.type === "run:start")).toHaveLength(1);
  });

  it("returns the first continue to a retry with its request ID, made after it or at once, and runs once", async () => {
    const { faux, session, reader } = await turnLimited();
    faux.setResponses([fauxAssistantMessage("a is apples."), fauxAssistantMessage("Again?")]);
    const [first, together] = await Promise.all([
      session.continue({ requestId: "c-1" }),
      session.continue({ requestId: "c-1" }),
    ]);
    expect(together).toEqual(first);
    await reader.until((items) => runEnds(items) === 2);
    expect(await session.continue({ requestId: "c-1" })).toEqual(first);
    // Give a third run every chance to start; none does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reader.stop();
    expect(reader.items.filter((item) => item.event.type === "run:start")).toHaveLength(2);
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("ends at once, nothing_to_answer, after an answer, live and in history alike", async () => {
    const { faux, instance } = setup();
    const session = instance.session((await instance.createSession()).id);
    faux.setResponses([fauxAssistantMessage("Hello."), fauxAssistantMessage("Hello again.")]);
    const reader = follow(session);
    await session.submit({ text: "Hi", requestId: "1" });
    await reader.until((items) => runEnds(items) === 1);

    await session.continue({ requestId: "c-1" });
    await reader.until((items) => runEnds(items) === 2);
    expect(runEndsOf(reader.items).at(-1)).toEqual({ type: "run:end", reason: "error", code: "nothing_to_answer" });
    expect(fold(reader.items).items.at(-1)).toEqual({ kind: "notice", reason: "error", code: "nothing_to_answer" });
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(fold(await readUntil(session, (_event, items) => runEnds(items) === 2))).toEqual(fold(reader.items));

    // Once a later run starts, the ending is read from the continue's settlement.
    await session.submit({ text: "Hi again", requestId: "2" });
    await reader.until((items) => runEnds(items) === 3);
    await reader.stop();
    expect(fold(await readUntil(session, (_event, items) => runEnds(items) === 3))).toEqual(fold(reader.items));
  });

  it("takes into its run the inputs a failed run left waiting, which start it as any run's input does", async () => {
    const { faux, instance } = setup();
    const session = instance.session((await instance.createSession({ maxTurns: 1 })).id);
    const through = door();
    opened = through.shut;
    faux.setResponses([call("gate", "g-1"), fauxAssistantMessage("Through, and noted.")]);
    const reader = follow(session);
    await session.submit({ text: "Go through", requestId: "1" });
    await reader.until((items) => items.some((item) => item.event.type === "tool:start"));
    await session.submit({ text: "And note it", requestId: "2" });
    through.open();
    await reader.until((items) => runEnds(items) === 1);
    // The failed run left it waiting.
    expect(fold(reader.items).queued).toMatchObject([{ text: "And note it" }]);

    await session.continue({ requestId: "c-1" });
    await reader.until((items) => runEnds(items) === 2);
    const second = reader.items.slice(reader.items.findLastIndex((item) => item.event.type === "run:start"));
    expect(settledTypes(second)).toEqual(["run:start", "user", "assistant:end", "run:end"]);
    const view = fold(reader.items);
    expect(view.queued).toBeUndefined();
    expect(fold(await readUntil(session, (_event, items) => runEnds(items) === 2))).toEqual(view);
    await expectEveryResumeFolds(session, reader.items);
    await reader.stop();
  });
});
