import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep, RegisterFauxProviderOptions } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

import {
  ApprovalNotPendingError,
  createAgentRuntime,
  defineAgent,
  defineTool,
  InvalidCursorError,
  SessionNotFoundError,
} from "../src/index.ts";
import type { AgentSession, AgentRuntime, AgentRuntimeOptions, ToolContext } from "../src/index.ts";
import { heldStreams } from "../src/runtime.ts";

import {
  committedOnly,
  eventually,
  expectEveryResumeFolds,
  fauxModels,
  follow,
  isRunEnd,
  memoryHost,
  readUntil,
  runEnds,
  settledTypes,
} from "./helpers.ts";

interface Ports {
  readonly notes: Map<string, string>;
  readonly deleted: string[];
}

const lookup = defineTool({
  name: "lookup",
  description: "Look up a note",
  tier: "read",
  label: "Look up",
  parameters: z.object({ key: z.string(), limit: z.number().int().optional() }),
  async execute({ key, limit }, { ports }: ToolContext<Ports>) {
    return { text: `note ${key}: ${ports.notes.get(key) ?? "missing"} (limit ${limit ?? "none"})`, details: { key } };
  },
});

const remove = defineTool({
  name: "remove",
  description: "Delete a note",
  tier: "write",
  parameters: z.object({ key: z.string() }),
  async execute({ key }, { ports }: ToolContext<Ports>) {
    ports.deleted.push(key);
    ports.notes.delete(key);
    return { text: `deleted ${key}` };
  },
});

let waitStarted: () => void = () => undefined;
const wait = defineTool({
  name: "wait",
  description: "Wait until stopped",
  tier: "read",
  parameters: z.object({}),
  async execute(_args, { signal }) {
    waitStarted();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("stopped");
  },
});

const notesAgent = defineAgent<Ports>({
  kind: "notes",
  instructions: "You keep notes.",
  tools: [lookup, remove, wait],
  policy: { requiresApproval: ["write"] },
});

const textOf = (message: unknown) => JSON.stringify((message as { content?: unknown } | undefined)?.content ?? message);

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

function setup(
  options: { faux?: RegisterFauxProviderOptions; settings?: AgentRuntimeOptions<Ports>["settings"] } = {},
) {
  const { faux, models, model } = fauxModels(options.faux);
  const ports: Ports = { notes: new Map([["a", "apples"]]), deleted: [] };
  runtime = createAgentRuntime({
    agents: [notesAgent],
    host: memoryHost(),
    models,
    ports,
    defaultModel: model,
    ...(options.settings && { settings: options.settings }),
  });
  const instance = runtime.get(notesAgent, "alice");
  return { faux, ports, instance };
}

describe("a submitted message", () => {
  it("produces the expected event sequence and folds into the expected view", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage("Hello there.")]);
    const { id } = await instance.createSession();
    const session = instance.session(id);

    await session.submit({ text: "Hi", requestId: "m1" });
    const items = await readUntil(session, isRunEnd);

    expect(settledTypes(items)).toEqual(["run:start", "user", "assistant:end", "run:end"]);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    const view = foldEvents(items.map((item) => item.event));
    expect(view.status).toBe("idle");
    expect(view.items).toMatchObject([
      { kind: "user", text: "Hi", streaming: false },
      { kind: "assistant", text: "Hello there.", streaming: false, stopReason: "stop" },
    ]);
    // Live and replayed agree: a client attaching now gets the same view.
    expect(foldEvents((await readUntil(instance.session(id), isRunEnd)).map((item) => item.event))).toEqual(view);
    expect(await instance.listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
  });

  it("rejects an unknown session", async () => {
    const { instance } = setup();
    await expect(instance.session("999").submit({ text: "x", requestId: "r" })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    await expect(instance.session("nope").abort()).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("tool calls", () => {
  it("runs a tool with the app's ports and hands its result to the model", async () => {
    const { faux, instance } = setup();
    let sawResult: unknown;
    faux.setResponses([
      // An optional parameter the model fills with null is dropped before validation.
      fauxAssistantMessage(fauxToolCall("lookup", { key: "a", limit: null }, { id: "call-1" }), {
        stopReason: "toolUse",
      }),
      (context) => {
        sawResult = context.messages.at(-1);
        return fauxAssistantMessage("Found it.");
      },
    ]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "What is a?", requestId: "q1" });
    const items = await readUntil(session, isRunEnd);

    expect(sawResult).toMatchObject({ role: "toolResult", toolCallId: "call-1", isError: false });
    expect(textOf(sawResult)).toContain("note a: apples (limit none)");
    expect(settledTypes(items)).toEqual([
      "run:start",
      "user",
      "assistant:end",
      "tool:start",
      "tool:end",
      "assistant:end",
      "run:end",
    ]);
    const start = items.find((item) => item.event.type === "tool:start")?.event;
    expect(start).toEqual({
      type: "tool:start",
      toolCallId: "call-1",
      toolName: "lookup",
      label: "Look up",
      tier: "read",
      args: { key: "a", limit: null },
    });
    const view = foldEvents(items.map((item) => item.event));
    expect(view.items[2]).toMatchObject({ kind: "tool", status: "ok", details: { key: "a" } });
  });

  it("returns invalid arguments to the model as an error", async () => {
    // pi coerces what it can (a number for a string); a missing required key it cannot.
    const { faux, instance } = setup();
    let sawResult: unknown;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", { limit: 2 }, { id: "bad" }), { stopReason: "toolUse" }),
      (context) => {
        sawResult = context.messages.at(-1);
        return fauxAssistantMessage("Sorry.");
      },
    ]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "x", requestId: "x" });
    const items = await readUntil(session, isRunEnd);
    expect(sawResult).toMatchObject({ role: "toolResult", isError: true });
    expect(items.find((item) => item.event.type === "tool:end")?.event).toMatchObject({ status: "error" });
  });
});

describe("approval", () => {
  async function gatedRun(
    decide: (session: ReturnType<ReturnType<typeof setup>["instance"]["session"]>) => Promise<void>,
  ) {
    const context = setup();
    let sawResult: unknown;
    context.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-1" }), { stopReason: "toolUse" }),
      (request) => {
        sawResult = request.messages.at(-1);
        return fauxAssistantMessage("Done.");
      },
    ]);
    const { id } = await context.instance.createSession();
    const session = context.instance.session(id);
    await session.submit({ text: "Delete a", requestId: "d1" });
    const asked = await readUntil(session, (event) => event.type === "approval:request");
    expect(asked.at(-1)?.event).toEqual({
      type: "approval:request",
      toolCallId: "rm-1",
      toolName: "remove",
      tier: "write",
      args: { key: "a" },
    });
    const waiting = foldEvents(asked.map((item) => item.event));
    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.pendingApprovals).toEqual(["rm-1"]);
    // Nothing ran while it waited.
    expect(context.ports.deleted).toEqual([]);
    await decide(session);
    const items = await readUntil(session, isRunEnd);
    return { ...context, session, items, sawResult: () => sawResult };
  }

  it("waits, then runs the call once approved", async () => {
    const { ports, items, sawResult, session } = await gatedRun(async (session) => {
      expect(await session.approve([{ toolCallId: "rm-1", approved: true }])).toEqual([
        { toolCallId: "rm-1", outcome: "applied" },
      ]);
    });
    expect(ports.deleted).toEqual(["a"]);
    expect(textOf(sawResult())).toContain("deleted a");
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
    const view = foldEvents(items.map((item) => item.event));
    expect(view.items[2]).toMatchObject({ kind: "tool", status: "ok", approval: { approved: true } });
    expect(view.pendingApprovals).toEqual([]);
    // A second decision for the same call is refused: the call is no longer waiting.
    await expect(session.approve([{ toolCallId: "rm-1", approved: false }])).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
  });

  it("returns the operator's comment to the model when declined", async () => {
    const { ports, items, sawResult } = await gatedRun(async (session) => {
      await session.approve([{ toolCallId: "rm-1", approved: false, comment: "Keep the apples." }]);
    });
    expect(ports.deleted).toEqual([]);
    const result = sawResult() as { isError: boolean; content: { type: string; text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "The operator declined this call: Keep the apples." }]);
    const end = items.find((item) => item.event.type === "tool:end")?.event;
    expect(end).toMatchObject({ status: "error", error: "The operator declined this call: Keep the apples." });
    const resolved = items.find((item) => item.event.type === "approval:resolved")?.event;
    expect(resolved).toEqual({
      type: "approval:resolved",
      toolCallId: "rm-1",
      approved: false,
      comment: "Keep the apples.",
    });
  });

  it("replays the decision into a late client's view", async () => {
    const { items, instance, session } = await gatedRun(async (session) => {
      await session.approve([{ toolCallId: "rm-1", approved: false, comment: "no" }]);
    });
    const live = foldEvents(items.map((item) => item.event));
    // A fresh instance handle reads the same stream; a fresh runtime would replay from storage (motoko-node tests).
    const again = await readUntil(instance.session(session.id), isRunEnd);
    expect(foldEvents(again.map((item) => item.event))).toEqual(live);
  });

  it("refuses a decision for a call that is not waiting", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage("Nothing to do.")]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "x", requestId: "x" });
    await readUntil(session, isRunEnd);
    await expect(session.approve([{ toolCallId: "ghost", approved: true }])).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
  });
});

describe("abort", () => {
  it("ends a run with a running tool as aborted", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}, { id: "w-1" }), { stopReason: "toolUse" })]);
    const started = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "Wait", requestId: "w" });
    await started;
    await session.abort();
    const items = await readUntil(session, isRunEnd);
    const events = items.map((item) => item.event);
    expect(events.at(-1)).toMatchObject({ type: "run:end", reason: "aborted" });
    expect(events.find((event) => event.type === "tool:end")).toMatchObject({ toolCallId: "w-1", status: "aborted" });
    const view = foldEvents(events);
    expect(view.status).toBe("idle");
    expect(view.items.at(-1)).toMatchObject({ kind: "notice", reason: "aborted" });
  });

  it("withdraws a pending approval", async () => {
    const { faux, instance, ports } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-2" }), { stopReason: "toolUse" }),
    ]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "Delete", requestId: "d" });
    await readUntil(session, (event) => event.type === "approval:request");
    await session.abort();
    const items = await readUntil(session, isRunEnd);
    const view = foldEvents(items.map((item) => item.event));
    expect(view.pendingApprovals).toEqual([]);
    expect(view.items.find((item) => item.kind === "tool")).toMatchObject({ status: "aborted" });
    await expect(session.approve([{ toolCallId: "rm-2", approved: true }])).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
    expect(ports.deleted).toEqual([]);
  });
});

describe("reconnecting with a cursor", () => {
  it("resumes exactly within the process, also while the run goes on", async () => {
    const { faux, instance } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-3" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Removed."),
      fauxAssistantMessage("Second answer."),
    ]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    // Two clients follow from the start; one stays, the other drops at the question.
    const always = follow(session);
    const dropping = follow(session);
    await eventually(() => heldStreams(instance).readers === 2);
    await session.submit({ text: "Delete", requestId: "c1" });
    await dropping.until((items) => items.some((item) => item.event.type === "approval:request"));
    await dropping.stop();
    const cursor = dropping.items.at(-1)!.cursor;

    // The run goes on without it, and the client comes back while it is still the latest run.
    await session.approve([{ toolCallId: "rm-3", approved: true }]);
    const back = follow(session, cursor);
    await back.until((items) => runEnds(items) === 1);
    await session.submit({ text: "Again", requestId: "c2" });
    await always.until((items) => runEnds(items) === 2);
    await back.until((items) => runEnds(items) === 2);
    await Promise.all([always.stop(), back.stop()]);

    // Event for event, cursor for cursor, what the client that stayed read.
    expect([...dropping.items, ...back.items]).toEqual(always.items);
    expect(new Set(always.items.map((item) => item.cursor)).size).toBe(always.items.length);
    // Resuming from the last cursor yields nothing but what comes next, and the queue it may hold stated again.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const after: AgentWireEvent[] = [];
    for await (const item of session.events({ from: always.items.at(-1)!.cursor, signal: controller.signal })) {
      after.push(item.event);
    }
    expect(after).toEqual([{ type: "queue", items: [] }]);
  });

  it("carries on from committed state once its run has left the log, without a full replay", async () => {
    const { faux, instance } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-4" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Removed."),
      fauxAssistantMessage("Second answer."),
    ]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    const always = follow(session);
    const dropping = follow(session);
    await eventually(() => heldStreams(instance).readers === 2);
    await session.submit({ text: "Delete", requestId: "c1" });
    await dropping.until((items) => items.some((item) => item.event.type === "approval:request"));
    await dropping.stop();
    const cursor = dropping.items.at(-1)!.cursor;
    await session.approve([{ toolCallId: "rm-4", approved: true }]);
    await always.until((items) => runEnds(items) === 1);
    // A second run starts: the log keeps only it now.
    await session.submit({ text: "Again", requestId: "c2" });
    await always.until((items) => runEnds(items) === 2);
    await always.stop();

    const back = await readUntil(session, (_event, items) => runEnds(items) === 2, { from: cursor });
    const events = back.map((item) => item.event);
    expect(events.some((event) => event.type === "stream:reset")).toBe(false);
    // Only what was committed after the cursor: the first message is not sent again.
    expect(events.filter((event) => event.type === "user").map((event) => event.type === "user" && event.text)).toEqual(
      ["Again"],
    );
    expect(foldEvents([...dropping.items, ...back].map((item) => item.event))).toEqual(
      foldEvents(always.items.map((item) => item.event)),
    );
  });

  it("rejects a cursor that is not one, or is another session's", async () => {
    const { faux, instance } = setup();
    faux.setResponses([]);
    const { id } = await instance.createSession();
    const other = await instance.createSession();
    const iterator = instance.session(id).events({ from: "garbage" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/Not a cursor/);
    const foreignEvents = instance.session(id).events({ from: `${other.id}.0.-` });
    const foreign = foreignEvents[Symbol.asyncIterator]();
    await expect(foreign.next()).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("answers a cursor storage cannot honour with stream:reset and a full replay", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "Hello", requestId: "h" });
    const live = await readUntil(session, isRunEnd);
    // An entry this session's storage never held, as after a restore from an older backup.
    const items = await readUntil(session, isRunEnd, { from: `${id}.999999.-` });
    expect(items[0]?.event).toEqual({ type: "stream:reset" });
    expect(foldEvents(items.map((item) => item.event))).toEqual(foldEvents(live.map((item) => item.event)));
  });
});

describe("resuming from committed state", () => {
  // `committedOnly` drops the cursor's place in this process's log, so these resume as another
  // process on the same storage would; motoko-node's tests do it across real processes too.
  it("folds a cut while a tool runs into the view of a client connected all along", async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let progressed: () => void = () => undefined;
    const progress = new Promise<void>((resolve) => {
      progressed = resolve;
    });
    const job = defineTool({
      name: "job",
      description: "A long job",
      tier: "read",
      parameters: z.object({}),
      async execute(_args, { output, update }) {
        output("step 1\n");
        await update({ step: 1 });
        progressed();
        await released;
        return { text: "job done", details: { step: 2 } };
      },
    });
    const agent = defineAgent({ kind: "jobs", instructions: "Work.", tools: [job] });
    const { faux, models, model } = fauxModels();
    runtime = createAgentRuntime({ agents: [agent], host: memoryHost(), models, ports: {}, defaultModel: model });
    const jobs = runtime.get(agent, "j");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("job", {}, { id: "j-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("All done."),
    ]);
    const { id } = await jobs.createSession();
    const session = jobs.session(id);
    const always = follow(session);
    const dropping = follow(session);
    await eventually(() => heldStreams(jobs).readers === 2);
    await session.submit({ text: "Run the job", requestId: "j" });
    await dropping.until((items) => items.some((item) => item.event.type === "tool:start"));
    await dropping.stop();
    const cursor = committedOnly(dropping.items.at(-1)!.cursor);
    await progress;
    // Progress lands on a throttle: wait until the connected client has it.
    await always.until((items) =>
      items.some((item) => item.event.type === "tool:update" && item.event.details !== undefined),
    );

    const back = follow(session, cursor);
    await eventually(() => back.items.some((item) => item.event.type === "tool:update"));
    const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));
    const mid = fold([...dropping.items, ...back.items]);
    expect(mid).toEqual(fold(always.items));
    expect(mid.items.find((item) => item.kind === "tool")).toMatchObject({
      status: "running",
      progress: "step 1\n",
      details: { step: 1 },
    });
    expect(back.items.some((item) => item.event.type === "user")).toBe(false);

    release();
    await always.until((items) => runEnds(items) === 1);
    await back.until((items) => runEnds(items) === 1);
    await Promise.all([always.stop(), back.stop()]);
    expect(fold([...dropping.items, ...back.items])).toEqual(fold(always.items));
  });

  it("re-asks a pending approval, and sends a decision made while the client was away", async () => {
    const { faux, instance } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-5" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Removed."),
    ]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    const always = follow(session);
    const dropping = follow(session);
    await eventually(() => heldStreams(instance).readers === 2);
    await session.submit({ text: "Delete", requestId: "d" });
    await dropping.until((items) => items.some((item) => item.event.type === "approval:request"));
    await dropping.stop();
    const cursor = committedOnly(dropping.items.at(-1)!.cursor);
    const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));

    // Still pending: the question comes again, and folds into the same view.
    const pending = follow(session, cursor);
    await pending.until((items) => items.some((item) => item.event.type === "approval:request"));
    await pending.stop();
    expect(fold([...dropping.items, ...pending.items])).toEqual(fold(always.items));
    expect(fold(pending.items).pendingApprovals).toEqual(["rm-5"]);

    // Decided while away: the decision arrives with the rest of the run.
    await session.approve([{ toolCallId: "rm-5", approved: true }]);
    await always.until((items) => runEnds(items) === 1);
    await always.stop();
    const back = await readUntil(session, isRunEnd, { from: cursor });
    expect(back.some((item) => item.event.type === "approval:resolved")).toBe(true);
    const view = fold([...dropping.items, ...back]);
    expect(view).toEqual(fold(always.items));
    expect(view.items.find((item) => item.kind === "tool")).toMatchObject({
      status: "ok",
      approval: { approved: true },
    });
  });
});

describe("resuming at any cursor", () => {
  // The resync contract between the transcriber and wire's reducer: what a resumed stream sends
  // again (the stretch of history after the client's entry, the in-flight state as it is now) the
  // reducer applies idempotently, so a client resuming from any cursor of a client connected all
  // along folds into that client's view. It binds hardest where the run waits, since the in-flight
  // state is then the last word, so each scenario checks there too, then once both runs are over.
  type Follower = ReturnType<typeof follow>;
  const resumes = (session: AgentSession, live: Follower) => expectEveryResumeFolds(session, live.items);
  const parked = async (session: AgentSession, live: Follower) => {
    await live.until((items) => items.some((item) => item.event.type === "approval:request"));
    await resumes(session, live);
  };
  it.each<{
    name: string;
    responses: FauxResponseStep[];
    run: (session: AgentSession, live: Follower) => Promise<void>;
  }>([
    {
      name: "a tool call",
      responses: [
        fauxAssistantMessage(fauxToolCall("lookup", { key: "a" }, { id: "call-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Found it."),
      ],
      run: async (session) => {
        await session.submit({ text: "What is a?", requestId: "1" });
      },
    },
    {
      name: "a parked call approved",
      responses: [
        fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Removed."),
      ],
      run: async (session, live) => {
        await session.submit({ text: "Delete a", requestId: "1" });
        await parked(session, live);
        await session.approve([{ toolCallId: "rm-1", approved: true }]);
      },
    },
    {
      name: "a parked call declined",
      responses: [
        fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Kept."),
      ],
      run: async (session, live) => {
        await session.submit({ text: "Delete a", requestId: "1" });
        await parked(session, live);
        await session.approve([{ toolCallId: "rm-1", approved: false, comment: "Keep the apples." }]);
      },
    },
    {
      name: "a retry",
      responses: [
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
        fauxAssistantMessage("Recovered."),
      ],
      run: async (session) => {
        await session.submit({ text: "Hi", requestId: "1" });
      },
    },
    {
      name: "an aborted run",
      responses: [fauxAssistantMessage(fauxToolCall("wait", {}, { id: "w-1" }), { stopReason: "toolUse" })],
      run: async (session, live) => {
        const started = new Promise<void>((resolve) => {
          waitStarted = resolve;
        });
        await session.submit({ text: "Wait", requestId: "1" });
        await started;
        await live.until((items) => items.some((item) => item.event.type === "tool:start"));
        await resumes(session, live);
        await session.abort();
      },
    },
  ])("folds into the connected view, through $name and a second submit", async ({ responses, run }) => {
    // Replies stream in pieces, each committed, so the stream holds deltas and drafts; a retry waits briefly.
    const { faux, instance } = setup({
      faux: { tokensPerSecond: 50, tokenSize: { min: 2, max: 2 } },
      settings: { progress: { partialIntervalMs: 5 }, retry: { baseDelayMs: 20 } },
    });
    faux.setResponses([...responses, fauxAssistantMessage("Still here.")]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    const live = follow(session);
    await eventually(() => heldStreams(instance).readers === 1);
    await run(session, live);
    await live.until((items) => runEnds(items) === 1);
    await session.submit({ text: "And now?", requestId: "2" });
    await live.until((items) => runEnds(items) === 2);

    await resumes(session, live);
    await live.stop();
  });
});

describe("a run that ended without an answer, then another run", () => {
  it("ends the same way for a client connected all along, a late one, and one resuming at any cursor", async () => {
    const { faux, models, model } = fauxModels();
    const agent = defineAgent({ kind: "flaky", instructions: "Answer.", tools: [] });
    let calls = 0;
    runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      // The first run's generation cannot reach the models: pi faults it, and leaves no entry saying so.
      models: () => {
        calls += 1;
        if (calls === 2) throw new Error("models down");
        return models;
      },
      ports: {},
      defaultModel: model,
    });
    faux.setResponses([fauxAssistantMessage("Back.")]);
    const instance = runtime.get(agent, "f");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    const always = follow(session);
    await eventually(() => heldStreams(instance).readers === 1);
    await session.submit({ text: "First", requestId: "1" });
    await always.until((items) => runEnds(items) === 1);
    await session.submit({ text: "Second", requestId: "2" });
    await always.until((items) => runEnds(items) === 2);
    const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));
    expect(always.items.find((item) => isRunEnd(item.event))?.event).toEqual({
      type: "run:end",
      reason: "error",
      code: "faulted",
      error: "models down",
    });

    // pi-durable's `pi.live` keeps only the newest run's failure; the inputs' settlement keeps each.
    const late = await readUntil(session, (_event, items) => runEnds(items) === 2);
    expect(fold(late)).toEqual(fold(always.items));
    await expectEveryResumeFolds(session, always.items);
    await always.stop();
  });
});

describe("bounded memory", () => {
  it("holds nothing for a session with no reader and no run, and only the current run otherwise", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two."), fauxAssistantMessage("Three.")]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    expect(heldStreams(instance)).toEqual({ sessions: 0, events: 0, readers: 0 });

    // A run with nobody reading is followed while it goes, then let go.
    await session.submit({ text: "1", requestId: "1" });
    expect(heldStreams(instance).sessions).toBe(1);
    await eventually(() => heldStreams(instance).sessions === 0);
    expect(heldStreams(instance)).toEqual({ sessions: 0, events: 0, readers: 0 });

    // A reader across two more runs: the log keeps the run going on, not the session's history.
    const reader = follow(session);
    await reader.until((items) => runEnds(items) === 1);
    await session.submit({ text: "2", requestId: "2" });
    await reader.until((items) => runEnds(items) === 2);
    await session.submit({ text: "3", requestId: "3" });
    await reader.until((items) => runEnds(items) === 3);
    const lastRun = reader.items.slice(reader.items.findLastIndex((item) => item.event.type === "run:start"));
    expect(heldStreams(instance)).toEqual({ sessions: 1, events: lastRun.length, readers: 1 });

    // The reader leaves and no run goes on: nothing is held.
    await reader.stop();
    expect(heldStreams(instance)).toEqual({ sessions: 0, events: 0, readers: 0 });
  });
});

describe("idempotent submit", () => {
  it("does not submit the same requestId twice", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage("Once."), fauxAssistantMessage("Twice?")]);
    const { id } = await instance.createSession();
    const session = instance.session(id);
    const first = await session.submit({ text: "Hello", requestId: "same" });
    await readUntil(session, isRunEnd);
    const second = await session.submit({ text: "Hello", requestId: "same" });
    expect(second).toEqual(first);
    // Give a second run every chance to start; none does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const items = await readUntil(session, isRunEnd);
    expect(items.filter((item) => item.event.type === "user")).toHaveLength(1);
    expect(faux.state.callCount).toBe(1);
    expect(faux.getPendingResponseCount()).toBe(1);
  });
});
