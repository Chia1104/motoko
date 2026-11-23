import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { decodeCursor, foldEvents } from "@chia1104/motoko-wire";
import type { StreamItem } from "@chia1104/motoko-wire";

import {
  callErrorOf,
  createAgentRuntime,
  defineAgent,
  defineTool,
  InvalidRequestError,
  runCall,
} from "../src/index.ts";
import type { AgentRuntime } from "../src/index.ts";

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
  runEnds,
  settledTypes,
} from "./helpers.ts";

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("inputs queued behind a run", () => {
  it("each run in turn, in the order they were submitted", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = defineTool({
      name: "hold",
      description: "Hold until released",
      tier: "read",
      parameters: z.object({}),
      async execute() {
        started();
        await released;
        return { text: "held" };
      },
    });
    const agent = defineAgent({ kind: "queue", instructions: "You answer.", tools: [hold] });
    const { faux, models, model } = fauxModels();
    runtime = createAgentRuntime({ agents: [agent], host: memoryHost(), models, ports: {}, defaultModel: model });
    const instance = runtime.get(agent, "alice");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("First answer."),
      fauxAssistantMessage("Second answer."),
      fauxAssistantMessage("Third answer."),
    ]);
    const { id } = await instance.createSession();
    const session = instance.session(id);

    await session.submit({ text: "A", requestId: "a" });
    await running;
    await session.submit({ text: "B", requestId: "b" });
    await session.submit({ text: "C", requestId: "c" });
    release();

    const ends = (items: readonly { event: { type: string } }[]) =>
      items.filter((item) => item.event.type === "run:end").length;
    const items = await readUntil(session, (_event, read) => ends(read) === 3);

    expect(settledTypes(items)).toEqual([
      "run:start",
      "user",
      "assistant:end",
      "tool:start",
      "tool:end",
      "assistant:end",
      "run:end",
      "run:start",
      "user",
      "assistant:end",
      "run:end",
      "run:start",
      "user",
      "assistant:end",
      "run:end",
    ]);
    const texts = items.flatMap((item) => (item.event.type === "user" ? [item.event.text] : []));
    expect(texts).toEqual(["A", "B", "C"]);
    expect(items.filter((item) => item.event.type === "run:end").map((item) => item.event)).toEqual([
      { type: "run:end", reason: "done" },
      { type: "run:end", reason: "done" },
      { type: "run:end", reason: "done" },
    ]);
    // A client attaching afterwards folds the same view.
    const replayed = await readUntil(instance.session(id), (_event, read) => ends(read) === 3);
    expect(foldEvents(replayed.map((item) => item.event))).toEqual(foldEvents(items.map((item) => item.event)));
  });
});

/** A promise to wait for and the function that settles it. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** `hold` waits until its call's `n` gate opens, or until its instance stops it. */
function holding() {
  const gates = new Map<number, ReturnType<typeof gate>>();
  const started = new Map<number, ReturnType<typeof gate>>();
  const of = (map: Map<number, ReturnType<typeof gate>>, n: number) => {
    let found = map.get(n);
    if (found === undefined) {
      found = gate();
      map.set(n, found);
    }
    return found;
  };
  const tool = defineTool({
    name: "hold",
    description: "Hold until released",
    tier: "read",
    replay: "safe",
    parameters: z.object({ n: z.number() }),
    async execute({ n }, { signal }) {
      of(started, n).open();
      await Promise.race([
        of(gates, n).opened,
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      ]);
      return { text: `held ${n}` };
    },
  });
  return {
    tool,
    started: (n: number) => of(started, n).opened,
    release: (n: number) => of(gates, n).open(),
  };
}

const holdCall = (n: number) =>
  fauxAssistantMessage([fauxToolCall("hold", { n }, { id: `hold-${n}` })], { stopReason: "toolUse" });

/** A reply the model gives only once `opened` resolves: a generation that goes on until then. */
const answerAfter = (opened: Promise<void>, text: string) => async () => {
  await opened;
  return fauxAssistantMessage(text);
};

const users = (items: readonly StreamItem[]) =>
  items.flatMap((item) => (item.event.type === "user" ? [item.event] : []));
const queues = (items: readonly StreamItem[]) =>
  items.flatMap((item) => (item.event.type === "queue" ? [item.event.items] : []));
const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));

function setup(options: { settings?: HarnessSettings } = {}) {
  const hold = holding();
  const agent = defineAgent({ kind: "steer", instructions: "You answer.", tools: [hold.tool] });
  const { faux, models, model } = fauxModels();
  runtime = createAgentRuntime({
    agents: [agent],
    host: memoryHost(),
    models,
    ports: {},
    defaultModel: model,
    ...(options.settings !== undefined && { settings: options.settings }),
  });
  return { hold, faux, instance: runtime.get(agent, "alice") };
}

describe("a steer", () => {
  it("joins the run going on after its tool round: one run reads it and answers", async () => {
    const { hold, faux, instance } = setup();
    let read: string[] = [];
    faux.setResponses([
      holdCall(1),
      (context) => {
        read = context.messages.map((message) => message.role);
        return fauxAssistantMessage("Done, the other way.");
      },
    ]);
    const session = instance.session((await instance.createSession()).id);
    const live = follow(session);

    await session.submit({ text: "Do it", requestId: "a" });
    await hold.started(1);
    const { submissionId } = await session.submit({ text: "No, the other way", requestId: "s", whenBusy: "steer" });
    await live.until((items) => queues(items).length === 1);
    hold.release(1);
    const items = await live.until((reached) => runEnds(reached) === 1);

    expect(settledTypes(items)).toEqual([
      "run:start",
      "user",
      "assistant:end",
      "tool:start",
      "tool:end",
      "user",
      "assistant:end",
      "run:end",
    ]);
    expect(users(items).map(({ text, steer }) => ({ text, steer }))).toEqual([
      { text: "Do it", steer: undefined },
      { text: "No, the other way", steer: true },
    ]);
    // It waited in the queue, as a steer, until the round's results were in.
    expect(queues(items)).toEqual([[{ submissionId, text: "No, the other way", whenBusy: "steer" }], []]);
    // The model read it after the call's result.
    expect(read.slice(-2)).toEqual(["toolResult", "user"]);
    expect(fold(items).items).toMatchObject([
      { kind: "user", text: "Do it" },
      { kind: "assistant", stopReason: "toolUse" },
      { kind: "tool", status: "ok" },
      { kind: "user", text: "No, the other way", steer: true },
      { kind: "assistant", text: "Done, the other way." },
    ]);

    // A client attaching afterwards, or resuming anywhere, folds the same view.
    const replayed = await readUntil(session, (_event, read) => runEnds(read) === 1);
    expect(fold(replayed)).toEqual(fold(items));
    await expectEveryResumeFolds(session, items);
    await live.stop();
  });

  it("starts a run in a session no run holds, as any input does", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage("Hello.")]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Hi", requestId: "s", whenBusy: "steer" });
    const items = await readUntil(session, isRunEnd);
    expect(settledTypes(items)).toEqual(["run:start", "user", "assistant:end", "run:end"]);
    expect(users(items)[0]).not.toHaveProperty("steer");
  });

  it("that waits past the run's answer starts the next run, with the input queued before it", async () => {
    const { faux, instance } = setup();
    const answer = gate();
    faux.setResponses([answerAfter(answer.opened, "First."), fauxAssistantMessage("Both.")]);
    const session = instance.session((await instance.createSession()).id);
    const live = follow(session);

    await session.submit({ text: "A", requestId: "a" });
    await eventually(() => faux.state.callCount === 1);
    // No tool round comes before the answer: both wait for it, and the boundary after it places both.
    await session.submit({ text: "Then this", requestId: "f" });
    await session.submit({ text: "And this", requestId: "s", whenBusy: "steer" });
    await live.until((items) => queues(items).length === 2);
    answer.open();
    const items = await live.until((read) => runEnds(read) === 2);

    expect(settledTypes(items)).toEqual([
      "run:start",
      "user",
      "assistant:end",
      "run:end",
      "run:start",
      "user",
      "user",
      "assistant:end",
      "run:end",
    ]);
    expect(users(items).map(({ text, steer }) => ({ text, steer }))).toEqual([
      { text: "A", steer: undefined },
      { text: "Then this", steer: undefined },
      { text: "And this", steer: undefined },
    ]);
    const replayed = await readUntil(session, (_event, read) => runEnds(read) === 2);
    expect(fold(replayed)).toEqual(fold(items));
    await expectEveryResumeFolds(session, items);
    await live.stop();
  });

  it("in a run that then fails ends with it, and the next input starts a run", async () => {
    const { hold, faux, instance } = setup({ settings: { retry: { enabled: false } } });
    faux.setResponses([
      holdCall(1),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
      fauxAssistantMessage("Better now."),
    ]);
    const session = instance.session((await instance.createSession()).id);
    const live = follow(session);

    await session.submit({ text: "Do it", requestId: "a" });
    await hold.started(1);
    await session.submit({ text: "Faster", requestId: "s", whenBusy: "steer" });
    hold.release(1);
    await live.until((read) => runEnds(read) === 1);
    await session.submit({ text: "Again", requestId: "b" });
    const items = await live.until((read) => runEnds(read) === 2);

    expect(items.filter((item) => isRunEnd(item.event)).map((item) => item.event)).toEqual([
      { type: "run:end", reason: "error", code: "model_error", error: "overloaded" },
      { type: "run:end", reason: "done" },
    ]);
    expect(users(items).map(({ text, steer }) => ({ text, steer }))).toEqual([
      { text: "Do it", steer: undefined },
      { text: "Faster", steer: true },
      { text: "Again", steer: undefined },
    ]);
    const replayed = await readUntil(session, (_event, read) => runEnds(read) === 2);
    expect(fold(replayed)).toEqual(fold(items));
    await expectEveryResumeFolds(session, items);
    await live.stop();
  });
});

describe("the queue", () => {
  it("goes out whole whenever it changes, and an input withdrawn from it never runs", async () => {
    const { hold, faux, instance } = setup();
    faux.setResponses([holdCall(1), fauxAssistantMessage("First."), fauxAssistantMessage("Third.")]);
    const session = instance.session((await instance.createSession()).id);
    const live = follow(session);

    const a = await session.submit({ text: "A", requestId: "a" });
    await hold.started(1);
    const b = await session.submit({ text: "B", requestId: "b" });
    const c = await session.submit({ text: "C", requestId: "c" });
    await live.until((items) => queues(items).length === 2);
    expect(fold(live.items).queued).toEqual([
      { submissionId: b.submissionId, text: "B", whenBusy: "queue" },
      { submissionId: c.submissionId, text: "C", whenBusy: "queue" },
    ]);

    expect(await session.withdraw(b.submissionId)).toEqual({ outcome: "withdrawn" });
    expect(await session.withdraw(b.submissionId)).toEqual({ outcome: "settled" });
    // A run has it: too late to take back.
    expect(await session.withdraw(a.submissionId)).toEqual({ outcome: "already_placed" });
    hold.release(1);
    const items = await live.until((read) => runEnds(read) === 2);

    const [onlyB, both, onlyC, none] = [
      [{ submissionId: b.submissionId, text: "B", whenBusy: "queue" }],
      [
        { submissionId: b.submissionId, text: "B", whenBusy: "queue" },
        { submissionId: c.submissionId, text: "C", whenBusy: "queue" },
      ],
      [{ submissionId: c.submissionId, text: "C", whenBusy: "queue" }],
      [],
    ];
    expect(queues(items)).toEqual([onlyB, both, onlyC, none]);
    expect(users(items).map((user) => user.text)).toEqual(["A", "C"]);
    expect(fold(items)).not.toHaveProperty("queued");
    expect(await session.withdraw(c.submissionId)).toEqual({ outcome: "settled" });
    await expectEveryResumeFolds(session, items);
    await live.stop();
  });

  it("refuses to withdraw what the session does not hold", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
    const one = instance.session((await instance.createSession()).id);
    const two = instance.session((await instance.createSession()).id);
    const { submissionId } = await one.submit({ text: "Hi", requestId: "a" });
    await readUntil(one, isRunEnd);

    await expect(two.withdraw(submissionId)).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(one.withdraw("999")).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(one.withdraw("not-an-id")).rejects.toBeInstanceOf(InvalidRequestError);
    const refused = await runCall(instance, {
      method: "withdraw",
      params: { sessionId: two.id, submissionId },
    }).catch((error: unknown) => error);
    expect(callErrorOf(refused)).toMatchObject({ code: "invalid_request" });
    expect(await runCall(instance, { method: "withdraw", params: { sessionId: one.id, submissionId } })).toEqual({
      outcome: "settled",
    });
  });

  it("is dropped with an aborted run: what waited in it never runs", async () => {
    const { hold, faux, instance } = setup();
    faux.setResponses([holdCall(1), fauxAssistantMessage("Never."), fauxAssistantMessage("Later.")]);
    const session = instance.session((await instance.createSession()).id);
    const live = follow(session);

    await session.submit({ text: "A", requestId: "a" });
    await hold.started(1);
    await session.submit({ text: "B", requestId: "b" });
    await session.submit({ text: "S", requestId: "s", whenBusy: "steer" });
    await live.until((items) => queues(items).length === 2);
    await session.abort();
    await live.until((read) => runEnds(read) === 1);
    hold.release(1);
    await session.submit({ text: "C", requestId: "c" });
    const items = await live.until((read) => runEnds(read) === 2);
    await live.stop();

    expect(queues(items).at(-1)).toEqual([]);
    expect(items.find((item) => isRunEnd(item.event))?.event).toMatchObject({ reason: "aborted" });
    expect(users(items).map((user) => user.text)).toEqual(["A", "C"]);
    expect(fold(items)).not.toHaveProperty("queued");
  });
});

describe("a run with a steer, taken up by another process", () => {
  it("is the run of its first input: the stream that starts mid-run names that one", async () => {
    const place = memoryPlace();
    const hold = holding();
    const agent = defineAgent({ kind: "steer", instructions: "You answer.", tools: [hold.tool] });
    const first = fauxModels();
    const before = createAgentRuntime({
      agents: [agent],
      host: durableMemoryHost(place),
      models: first.models,
      ports: {},
      defaultModel: first.model,
    });
    first.faux.setResponses([holdCall(1), holdCall(2)]);
    const instance = before.get(agent, "alice");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "Do it", requestId: "a" });
    await hold.started(1);
    await session.submit({ text: "This way", requestId: "s", whenBusy: "steer" });
    hold.release(1);
    await hold.started(2);
    // The process goes down in the round after the steer.
    await before.close();
    hold.release(2);

    const second = fauxModels();
    const answer = gate();
    second.faux.setResponses([answerAfter(answer.opened, "Done.")]);
    runtime = createAgentRuntime({
      agents: [agent],
      host: durableMemoryHost(place),
      models: second.models,
      ports: {},
      defaultModel: second.model,
    });
    const again = runtime.get(agent, "alice").session(id);
    const live = follow(again);
    await eventually(() => second.faux.state.callCount === 1);
    await live.until((items) => users(items).length === 2);
    answer.open();
    const items = await live.until((read) => runEnds(read) === 1);
    await live.stop();

    const start = Number(users(items)[0]!.messageId);
    const runs = new Set(items.flatMap((item) => decodeCursor(item.cursor)?.run ?? []));
    expect(runs).toEqual(new Set([start]));
    expect(users(items).map(({ text, steer }) => ({ text, steer }))).toEqual([
      { text: "Do it", steer: undefined },
      { text: "This way", steer: true },
    ]);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
  });
});
