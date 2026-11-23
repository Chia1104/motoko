// Ports and models resolved per caller: `modelsFor` per instance from its scope, `portsFor` per tool
// call from its scope and session.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import type { StreamItem } from "@chia1104/motoko-wire";

import {
  createAgentRuntime,
  defineAgent,
  defineTool,
  ModelsUnavailableError,
  PortsUnavailableError,
} from "../src/index.ts";
import type { AgentRuntime, InstanceReport, PortsTarget, StorageScope, ToolContext } from "../src/index.ts";

import {
  durableMemoryHost,
  isRunEnd,
  keyedModel,
  keyedModels,
  memoryHost,
  memoryPlace,
  readUntil,
  runEnds,
} from "./helpers.ts";

interface UserPorts {
  readonly user: string;
  /** Granted per session, for some runs only. */
  readonly web?: { search(query: string): string };
}

const whoami = defineTool({
  name: "whoami",
  description: "Who the tool acts for",
  tier: "read",
  parameters: z.object({}),
  async execute(_args, { ports }: ToolContext<UserPorts>) {
    return { text: `acting for ${ports.user}` };
  },
});

const search = defineTool({
  name: "search",
  description: "Search the web",
  tier: "read",
  parameters: z.object({ query: z.string() }),
  async execute({ query }, { ports }: ToolContext<UserPorts>) {
    return { text: ports.web === undefined ? "no web access" : ports.web.search(query) };
  },
});

const agent = defineAgent<UserPorts>({
  kind: "assistant",
  instructions: "Help.",
  tools: [whoami, search],
  model: keyedModel,
});

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

const textOf = (value: unknown) => JSON.stringify(value);
const toolEnds = (items: readonly StreamItem[]) =>
  items.flatMap((item) => (item.event.type === "tool:end" ? [item.event] : []));
const answers = (items: readonly StreamItem[]) =>
  items.flatMap((item) => (item.event.type === "assistant:end" ? [item.event.text] : []));

/** A model turn that calls a tool, then one that answers with the key it was sent and the result it read. */
function callThenEcho(tool: string, args: Parameters<typeof fauxToolCall>[1], id: string): FauxResponseFactory[] {
  return [
    () => fauxAssistantMessage(fauxToolCall(tool, args, { id }), { stopReason: "toolUse" }),
    (context, options) => fauxAssistantMessage(`key=${options?.apiKey} saw=${textOf(context.messages.at(-1))}`),
  ];
}

describe("per-instance models and per-call ports", () => {
  it("serve each instance with its own caller's credentials and ports, never another's", async () => {
    const keys = new Map([
      ["alice", "key-alice"],
      ["bob", "key-bob"],
    ]);
    const callers = new Map([...keys.keys()].map((user) => [user, keyedModels(() => keys.get(user))] as const));
    const resolvedModels: string[] = [];
    const resolvedPorts: PortsTarget[] = [];
    const runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      modelsFor: async (scope) => {
        resolvedModels.push(scope.name);
        return callers.get(scope.name)!.models;
      },
      portsFor: async (target) => {
        resolvedPorts.push(target);
        return { user: target.scope.name };
      },
    });
    runtimes.push(runtime);
    for (const [user, { faux }] of callers) faux.setResponses(callThenEcho("whoami", {}, `who-${user}`));

    const runs = await Promise.all(
      ["alice", "bob"].map(async (user) => {
        const instance = runtime.get(agent, user);
        const { id } = await instance.createSession();
        const session = instance.session(id);
        await session.submit({ text: "Who am I?", requestId: "q" });
        return { user, id, items: await readUntil(session, isRunEnd) };
      }),
    );

    for (const { user, id, items } of runs) {
      const other = user === "alice" ? "bob" : "alice";
      const answer = textOf(answers(items).at(-1));
      expect(answer).toContain(`key=key-${user}`);
      expect(answer).toContain(`acting for ${user}`);
      expect(answer).not.toContain(other);
      // Each instance's tool calls were resolved for its own scope and session alone.
      const mine = resolvedPorts.filter((target) => target.scope.name === user);
      expect(mine.map(({ sessionId, toolCallId, toolName }) => ({ sessionId, toolCallId, toolName }))).toEqual([
        { sessionId: id, toolCallId: `who-${user}`, toolName: "whoami" },
      ]);
    }
    // Each caller's provider answered only its own instance.
    expect(callers.get("alice")!.faux.state.callCount).toBe(2);
    expect(callers.get("bob")!.faux.state.callCount).toBe(2);
    expect(new Set(resolvedModels)).toEqual(new Set(["alice", "bob"]));
  });

  it("keeps a static ports object and a static Models working, inferred without casts", async () => {
    const { models, faux } = keyedModels(() => "house-key");
    const runtime = createAgentRuntime({ agents: [agent], host: memoryHost(), models, ports: { user: "everyone" } });
    runtimes.push(runtime);
    faux.setResponses(callThenEcho("whoami", {}, "w"));
    const instance = runtime.get(agent, "x");
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Who?", requestId: "r" });
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(textOf(answers(items).at(-1))).toContain("key=house-key");
    expect(textOf(answers(items).at(-1))).toContain("acting for everyone");
    // `refreshModels()` has nothing to do with a static Models.
    await instance.refreshModels();
  });

  it("refuses options with both or neither of a static value and a resolver", () => {
    const { models } = keyedModels(() => "k");
    const base = { agents: [agent], host: memoryHost() };
    // @ts-expect-error: both `models` and `modelsFor`
    expect(() => createAgentRuntime({ ...base, models, modelsFor: () => models, ports: { user: "u" } })).toThrow(
      /exactly one of `models`/,
    );
    // @ts-expect-error: neither `ports` nor `portsFor`
    expect(() => createAgentRuntime({ ...base, models })).toThrow(/exactly one of `ports`/);
  });
});

describe("a grant withdrawn between two runs", () => {
  it("is seen by the second run, without reopening the instance", async () => {
    const granted = new Set<string>();
    const { models, faux } = keyedModels(() => "k");
    const runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      models,
      // Granted per session, looked up at each call: a database read in an app.
      portsFor: async ({ scope, sessionId }) => ({
        user: scope.name,
        ...(granted.has(sessionId) && { web: { search: (query: string) => `results for ${query}` } }),
      }),
    });
    runtimes.push(runtime);
    const instance = runtime.get(agent, "alice");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    faux.setResponses([
      ...callThenEcho("search", { query: "pi" }, "s-1"),
      ...callThenEcho("search", { query: "pi" }, "s-2"),
    ]);

    granted.add(id);
    await session.submit({ text: "Search", requestId: "1" });
    await readUntil(session, isRunEnd);
    granted.delete(id);
    await session.submit({ text: "Search again", requestId: "2" });
    const items = await readUntil(session, (_event, read) => runEnds(read) === 2);

    // Each run's answer echoes what its call read.
    const [first, second] = answers(items).filter((text) => text.startsWith("key="));
    expect(first).toContain("results for pi");
    expect(second).toContain("no web access");
    expect(instance.state).toBe("open");
  });
});

describe("a resolver that fails", () => {
  it("fails only the tool call it serves, which the model reads, and is reported", async () => {
    const reports: InstanceReport[] = [];
    let failing = true;
    const { models, faux } = keyedModels(() => "k");
    const runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      models,
      portsFor: async ({ scope, toolName }) => {
        if (failing && toolName === "search") throw new Error("grants table unreachable");
        return { user: scope.name };
      },
      onReport: (report) => reports.push(report),
    });
    runtimes.push(runtime);
    let sawResults: unknown;
    faux.setResponses([
      // One round with two calls: the one whose ports fail, and one whose ports resolve.
      () =>
        fauxAssistantMessage(
          [fauxToolCall("search", { query: "x" }, { id: "bad" }), fauxToolCall("whoami", {}, { id: "good" })],
          {
            stopReason: "toolUse",
          },
        ),
      (context) => {
        sawResults = context.messages.slice(-2);
        return fauxAssistantMessage("Done anyway.");
      },
      ...callThenEcho("search", { query: "y" }, "later"),
    ]);
    const instance = runtime.get(agent, "alice");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "Go", requestId: "1" });
    const items = await readUntil(session, isRunEnd);

    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    const ends = toolEnds(items);
    expect(ends.find((end) => end.toolCallId === "bad")).toMatchObject({ status: "error" });
    expect(ends.find((end) => end.toolCallId === "good")).toMatchObject({ status: "ok" });
    // The model read a clear error for that call alone, without the cause's internals.
    const bad = (sawResults as { toolCallId: string; isError: boolean; content: unknown }[]).find(
      (m) => m.toolCallId === "bad",
    );
    expect(bad?.isError).toBe(true);
    expect(textOf(bad?.content)).toContain("Tool `search` could not run");
    expect(textOf(bad?.content)).not.toContain("grants table");
    expect(reports).toEqual([
      {
        source: "runtime",
        scope: { kind: "assistant", name: "alice" },
        kind: "ports_failed",
        sessionId: id,
        toolCallId: "bad",
        toolName: "search",
        error: expect.objectContaining({ message: "grants table unreachable" }),
      },
    ]);
    expect(new PortsUnavailableError("search", undefined).message).toContain("could not run");

    // The instance carries on: the next call resolves again.
    failing = false;
    await session.submit({ text: "Again", requestId: "2" });
    const next = await readUntil(session, (_event, read) => runEnds(read) === 2);
    expect(toolEnds(next).find((end) => end.toolCallId === "later")).toMatchObject({ status: "ok" });
  });

  it("fails the model requests it serves with a clear error, keeps the instance usable, and recovers", async () => {
    const reports: InstanceReport[] = [];
    const { models, faux } = keyedModels(() => "k");
    let failures = 2;
    const runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      modelsFor: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("keys table unreachable");
        }
        return models;
      },
      ports: { user: "u" },
      onReport: (report) => reports.push(report),
    });
    runtimes.push(runtime);
    faux.setResponses([fauxAssistantMessage("Back.")]);
    const instance = runtime.get(agent, "alice");
    // Fails at open and again before the submit: reads and sessions still work.
    const { id } = await instance.createSession();
    expect(await instance.listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
    const session = instance.session(id);
    await session.submit({ text: "Hi", requestId: "1" });
    const failed = await readUntil(session, isRunEnd);
    expect(failed.at(-1)?.event).toEqual({
      type: "run:end",
      reason: "error",
      code: "faulted",
      error: new ModelsUnavailableError({ kind: "assistant", name: "alice" }, undefined).message,
    });
    const runtimeReports = reports.filter((report) => report.source === "runtime");
    expect(runtimeReports).toEqual([
      {
        source: "runtime",
        scope: { kind: "assistant", name: "alice" },
        kind: "models_failed",
        error: expect.objectContaining({ message: "keys table unreachable" }),
      },
      {
        source: "runtime",
        scope: { kind: "assistant", name: "alice" },
        kind: "models_failed",
        error: expect.objectContaining({ message: "keys table unreachable" }),
      },
    ]);
    // pi-durable reports the generation it faulted, with the runtime's error and its cause.
    expect(reports.some((report) => report.source === "pi" && report.report.kind === "task_faulted")).toBe(true);

    // The next submit resolves again, and succeeds.
    await session.submit({ text: "Again", requestId: "2" });
    const items = await readUntil(session, (_event, read) => runEnds(read) === 2);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    expect(instance.state).toBe("open");
  });
});

describe("a user's key changing while the instance is open", () => {
  it("takes effect at the next request through the Models' credential store, without the runtime", async () => {
    let key: string | undefined = "first-key";
    const { models, faux } = keyedModels(() => key);
    const runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      modelsFor: () => models,
      ports: { user: "u" },
    });
    runtimes.push(runtime);
    const seen: (string | undefined)[] = [];
    const echo: FauxResponseFactory = (_context, options) => {
      seen.push(options?.apiKey);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([echo, echo]);
    const instance = runtime.get(agent, "alice");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "1", requestId: "1" });
    await readUntil(session, isRunEnd);
    key = "rotated-key";
    await session.submit({ text: "2", requestId: "2" });
    await readUntil(session, (_event, read) => runEnds(read) === 2);
    // Removed: the request finds no credential and the run ends with the provider's error.
    key = undefined;
    await session.submit({ text: "3", requestId: "3" });
    const items = await readUntil(session, (_event, read) => runEnds(read) === 3);
    expect(seen).toEqual(["first-key", "rotated-key"]);
    expect(items.at(-1)?.event).toMatchObject({ type: "run:end", reason: "error" });
  });

  it("is picked up by refreshModels() for a Models the app rebuilds", async () => {
    const built: string[] = [];
    let current = "old";
    const runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      modelsFor: () => {
        built.push(current);
        const key = current;
        const access = keyedModels(() => key);
        access.faux.setResponses([(_context, options) => fauxAssistantMessage(`key=${options?.apiKey}`)]);
        return access.models;
      },
      ports: { user: "u" },
    });
    runtimes.push(runtime);
    const instance = runtime.get(agent, "alice");
    await instance.refreshModels(); // not open yet: nothing to do
    expect(built).toEqual([]);
    const { id } = await instance.createSession();
    current = "new";
    // Resolved now, not at the next submit: a run already going gets it at its next request.
    await instance.refreshModels();
    expect(built).toEqual(["old", "new"]);
    await instance.session(id).submit({ text: "Hi", requestId: "1" });
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(built).toEqual(["old", "new", "new"]);
    expect(textOf(answers(items).at(-1))).toContain("key=new");
  });
});

describe("a run resumed after a restart", () => {
  it("resolves its models and ports again from its scope and session", async () => {
    const place = memoryPlace();
    let releaseTool: () => void = () => undefined;
    let started: () => void = () => undefined;
    let finishing = false;
    const slow = defineTool({
      name: "slow",
      description: "Slow work that is safe to run again",
      tier: "read",
      replay: "safe",
      parameters: z.object({}),
      async execute(_args, { ports, signal }: ToolContext<UserPorts>) {
        started();
        if (!finishing) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("stopped by the host");
        }
        await new Promise<void>((resolve) => {
          releaseTool = resolve;
        });
        return { text: `done for ${ports.user}` };
      },
    });
    const worker = defineAgent<UserPorts>({ kind: "worker", instructions: "Work.", tools: [slow], model: keyedModel });
    const openRuntime = (generation: string, resolved: { models: StorageScope[]; ports: PortsTarget[] }) => {
      const access = keyedModels(() => `${generation}-key`);
      const runtime = createAgentRuntime({
        agents: [worker],
        host: durableMemoryHost(place),
        modelsFor: (scope) => {
          resolved.models.push(scope);
          return access.models;
        },
        portsFor: (target) => {
          resolved.ports.push(target);
          return { user: `${target.scope.name}@${generation}` };
        },
      });
      runtimes.push(runtime);
      return { runtime, faux: access.faux };
    };

    const before = { models: [] as StorageScope[], ports: [] as PortsTarget[] };
    const first = openRuntime("first", before);
    first.faux.setResponses([fauxAssistantMessage(fauxToolCall("slow", {}, { id: "s-1" }), { stopReason: "toolUse" })]);
    const instance = first.runtime.get(worker, "w1");
    const { id } = await instance.createSession();
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    await instance.session(id).submit({ text: "Work", requestId: "r" });
    await running;
    // The process stops mid-call; nothing of its resolvers is left.
    await first.runtime.close();

    finishing = true;
    const after = { models: [] as StorageScope[], ports: [] as PortsTarget[] };
    const second = openRuntime("second", after);
    second.faux.setResponses([
      (context, options) =>
        fauxAssistantMessage(`answered with ${options?.apiKey} saw=${textOf(context.messages.at(-1))}`),
    ]);
    const rerun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const session = second.runtime.get(worker, "w1").session(id);
    const reading = readUntil(session, isRunEnd);
    await rerun;
    releaseTool();
    const items = await reading;

    expect(after.models).toEqual([{ kind: "worker", name: "w1" }]);
    expect(after.ports.map(({ scope, sessionId, toolCallId }) => ({ scope, sessionId, toolCallId }))).toEqual([
      { scope: { kind: "worker", name: "w1" }, sessionId: id, toolCallId: "s-1" },
    ]);
    expect(toolEnds(items).at(-1)).toMatchObject({ toolCallId: "s-1", status: "ok" });
    expect(answers(items).at(-1)).toContain("answered with second-key");
    expect(answers(items).at(-1)).toContain("done for w1@second");
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    // The first process resolved them for its own run (at open and at the submit), the second
    // again, at its open, for the run it resumed.
    expect(before.models).toEqual([
      { kind: "worker", name: "w1" },
      { kind: "worker", name: "w1" },
    ]);
    expect(before.ports.map(({ toolCallId }) => toolCallId)).toEqual(["s-1"]);
  });
});

describe("a run resumed after a restart whose credentials cannot be resolved", () => {
  it("ends with a clear error, its committed state kept, on nobody else's credentials", async () => {
    const place = memoryPlace();
    const worker = defineAgent<UserPorts>({
      kind: "worker",
      instructions: "Work.",
      tools: [whoami],
      model: keyedModel,
    });
    const first = keyedModels(() => "first-key");
    let releaseAnswer: () => void = () => undefined;
    let answering: () => void = () => undefined;
    const answeringNow = new Promise<void>((resolve) => {
      answering = resolve;
    });
    // The first process dies while the model is answering: a request cut off by a close is sent again.
    first.faux.setResponses([
      async () => {
        answering();
        await new Promise<void>((resolve) => {
          releaseAnswer = resolve;
        });
        return fauxAssistantMessage("never seen");
      },
    ]);
    const before = createAgentRuntime({
      agents: [worker],
      host: durableMemoryHost(place),
      modelsFor: () => first.models,
      ports: { user: "u" },
    });
    runtimes.push(before);
    const { id } = await before.get(worker, "w2").createSession();
    await before.get(worker, "w2").session(id).submit({ text: "Hello", requestId: "r" });
    await answeringNow;
    const closing = before.close();
    releaseAnswer();
    await closing;

    const reports: InstanceReport[] = [];
    const after = createAgentRuntime({
      agents: [worker],
      host: durableMemoryHost(place),
      modelsFor: () => {
        throw new Error("the user's keys are gone");
      },
      ports: { user: "u" },
      onReport: (report) => reports.push(report),
    });
    runtimes.push(after);
    const items = await readUntil(after.get(worker, "w2").session(id), isRunEnd);
    expect(items.at(-1)?.event).toMatchObject({ type: "run:end", reason: "error", code: "faulted" });
    expect(
      items.filter((item) => item.event.type === "user").map((item) => item.event.type === "user" && item.event.text),
    ).toEqual(["Hello"]);
    expect(reports.some((report) => report.source === "runtime" && report.kind === "models_failed")).toBe(true);
    // The first process's provider answered once, when it was cut off, and never again.
    expect(first.faux.state.callCount).toBe(1);
  });
});
