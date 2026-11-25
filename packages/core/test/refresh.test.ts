// The app's extensions refreshed while an instance is open, driven through the runtime on the faux provider. Each
// test expects what the README's "App extensions" says under "Refreshing": a tool a refresh adds is offered from the
// next model request, also a run's already going, and `tool_search` loads a deferred one; a call waiting at the gate
// for a tool a refresh drops ends as unavailable, and so does one that parked on its own work, when it wakes; a task
// that a dropped extension's hook asked for still runs to its end; a refresh refuses what an open refuses (a failed
// `extensionsFor`, the names) and then changes nothing; refreshes take effect in call order; and a refresh waits for
// an open under way, and does nothing while the instance is not open.

import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  defineTask,
  defineTool as definePiTool,
  GenerationTask,
  hook,
  hookTask,
  wrapTool,
} from "@earendil-works/pi-durable";
import type { JsonObject, ToolRegistration } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentSessionView, AgentWireEvent, StreamItem, ToolItem } from "@chia1104/motoko-wire";

import { ApprovalNotPendingError, createAgentRuntime, defineAgent, defineTool } from "../src/index.ts";
import type { AgentRuntime, AppExtension, ExtensionsResolver, InstanceReport } from "../src/index.ts";

import { eventually, fauxModels, isRunEnd, memoryHost, readUntil, runEnds } from "./helpers.ts";

const remove = defineTool({
  name: "remove",
  description: "Delete a note",
  tier: "write",
  parameters: z.object({ key: z.string() }),
  async execute({ key }) {
    return { text: `deleted ${key}` };
  },
});

const desk = defineAgent({
  kind: "desk",
  instructions: "You run the desk.",
  tools: [remove],
  policy: { requiresApproval: ["write"] },
});

const text = (value: string) => [{ type: "text" as const, text: value }];

/** A pi-durable tool of the app's, answering `answer` to every call. */
const appTool = (name: string, answer: string, more: Partial<ToolRegistration> = {}): ToolRegistration =>
  definePiTool({
    name,
    description: `The ${name} tool`,
    parameters: { type: "object", properties: { city: { type: "string" } } },
    async execute() {
      return { output: text(answer) };
    },
    ...more,
  });

const search: AppExtension = { extension: createToolSearchExtension(), tier: () => "read" };
/** No tier: every call of it waits for approval. */
const shell: AppExtension = { extension: defineExtension({ name: "shell", tools: [appTool("shell", "ran")] }) };
const extra: AppExtension = {
  extension: defineExtension({ name: "extra", tools: [appTool("extra", "more")] }),
  tier: () => "read",
};

const done = { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
/** How long the title task sleeps once it starts. */
const NAP_MS = 150;

/** Names a session after its run: it sleeps a little first, then ends, counting both in `progress`. */
function titles(progress: { napped: number; named: number }): AppExtension {
  const title = defineTask<null, { phase: "nap" } | { phase: "name" }, null>({
    name: "app.title",
    version: 1,
    initial: () => ({ phase: "nap" }),
    phases: {
      async nap(_task, runtime, context) {
        await runtime.commit(
          async () => ({ status: "sleeping", checkpoint: { phase: "name" }, until: runtime.now() + NAP_MS }),
          context,
        );
        progress.napped += 1;
      },
      async name(_task, runtime, context) {
        await runtime.commit(async () => done, context);
        progress.named += 1;
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(async () => done, context);
    },
  });
  return {
    extension: defineExtension({
      name: "titles",
      tasks: [title],
      hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [hookTask(title, null)] }) })],
    }),
  };
}

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

/** A runtime whose `extensionsFor` gives what `listed()` lists at each call. */
function start(listed: ExtensionsResolver) {
  const models = fauxModels();
  const reports: InstanceReport[] = [];
  runtime = createAgentRuntime({
    agents: [desk],
    host: memoryHost(),
    models: models.models,
    ports: {},
    defaultModel: models.model,
    extensionsFor: listed,
    onReport: (report) => reports.push(report),
  });
  return { faux: models.faux, instance: runtime.get(desk, "alice"), reports };
}

const call = (name: string, args: JsonObject, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });

/** The names of the tools a request offers, replayed from its system messages: each removes, then adds. */
function offered(messages: readonly Message[]): string[] {
  const tools = new Set<string>();
  for (const message of messages.filter((each): each is SystemMessage => each.role === "system")) {
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
  }
  return [...tools].sort();
}

/** `steps` as the model answers them, keeping the messages of every request in `requests`. */
function recorded(steps: readonly FauxResponseStep[]) {
  const requests: Message[][] = [];
  const respond = steps.map((step): FauxResponseFactory => (request, options, state, model) => {
    requests.push(request.messages);
    return typeof step === "function" ? step(request, options, state, model) : step;
  });
  return { requests, respond };
}

const fold = (items: readonly StreamItem[]): AgentSessionView => foldEvents(items.map((item) => item.event));

const toolItem = (view: AgentSessionView, toolCallId: string) =>
  view.items.find((item): item is ToolItem => item.kind === "tool" && item.toolCallId === toolCallId);

const toolEnd = (items: readonly StreamItem[], toolCallId: string) =>
  items.find(({ event }) => event.type === "tool:end" && event.toolCallId === toolCallId)?.event;

const isAsked = (event: AgentWireEvent) => event.type === "approval:request";
const asked = (items: readonly StreamItem[]) =>
  items.flatMap(({ event }) => (event.type === "approval:request" ? [event] : []));

describe("refreshing app extensions", () => {
  it("offers a tool a refresh adds from the next model request of the run already going", async () => {
    let listed = [search];
    const { faux, instance } = start(() => listed);
    const { requests, respond } = recorded([
      call("remove", { key: "a" }, "r-1"),
      call("extra", {}, "x-1"),
      fauxAssistantMessage("Done."),
    ]);
    faux.setResponses(respond);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Tidy up", requestId: "1" });
    await readUntil(session, isAsked);

    listed = [search, extra];
    await instance.refreshExtensions();
    // A call waiting at the gate for a tool still selected keeps waiting for its decision.
    expect(await session.approve([{ toolCallId: "r-1", approved: true }])).toEqual([
      { toolCallId: "r-1", outcome: "applied" },
    ]);
    const items = await readUntil(session, isRunEnd);
    expect(offered(requests[0]!)).toEqual(["remove", "tool_search"]);
    expect(offered(requests[1]!)).toEqual(["extra", "remove", "tool_search"]);
    expect(toolItem(fold(items), "x-1")).toMatchObject({ tier: "read", status: "ok" });
    expect(asked(items)).toHaveLength(1);
  });

  it("has `tool_search` load a deferred tool a refresh adds", async () => {
    const sky: ToolRegistration[] = [];
    const { faux, instance } = start(() => [
      search,
      { extension: defineExtension({ name: "sky", tools: [...sky] }), tier: () => "read" },
    ]);
    const { requests, respond } = recorded([
      call("tool_search", { query: "forecast" }, "ts-1"),
      fauxAssistantMessage("No forecast."),
      call("tool_search", { query: "forecast" }, "ts-2"),
      call("forecast", { city: "Taipei" }, "f-1"),
      fauxAssistantMessage("Sunny in Taipei."),
    ]);
    faux.setResponses(respond);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Forecast?", requestId: "1" });
    await readUntil(session, isRunEnd);
    expect(offered(requests[1]!)).toEqual(["remove", "tool_search"]);

    sky.push(appTool("forecast", "sunny", { description: "The forecast for a city", deferred: true }));
    await instance.refreshExtensions();
    await session.submit({ text: "Forecast?", requestId: "2" });
    const items = await readUntil(session, (_event, read) => runEnds(read) === 2);
    expect(offered(requests[2]!)).toEqual(["remove", "tool_search"]);
    expect(offered(requests[3]!)).toEqual(["forecast", "remove", "tool_search"]);
    expect(toolEnd(items, "ts-2")).toMatchObject({ toolName: "tool_search", status: "ok" });
    expect(toolEnd(items, "f-1")).toMatchObject({ toolName: "forecast", status: "ok" });
    expect(items.at(-1)?.event).toMatchObject({ type: "run:end", reason: "done" });
  });

  it.each([
    { what: "another extension", after: [search], decided: false },
    { what: "none", after: [], decided: true },
  ])(
    "ends a call waiting at the gate for a tool a refresh drops, the refresh listing $what",
    async ({ after, decided }) => {
      let listed: readonly AppExtension[] = [search, shell];
      const { faux, instance } = start(() => listed);
      const { requests, respond } = recorded([call("shell", {}, "sh-1"), fauxAssistantMessage("No shell.")]);
      faux.setResponses(respond);
      const session = instance.session((await instance.createSession()).id);
      await session.submit({ text: "Run it", requestId: "1" });
      await readUntil(session, isAsked);

      listed = after;
      await instance.refreshExtensions();
      if (decided) {
        expect(await session.approve([{ toolCallId: "sh-1", approved: true }])).toEqual([
          { toolCallId: "sh-1", outcome: "applied" },
        ]);
      }
      const items = await readUntil(session, isRunEnd);
      expect(toolEnd(items, "sh-1")).toMatchObject({
        type: "tool:end",
        toolName: "shell",
        status: "error",
        error: expect.stringContaining("Tool shell is not available"),
      });
      expect(offered(requests[1]!)).not.toContain("shell");
      await expect(session.approve([{ toolCallId: "sh-1", approved: true }])).rejects.toBeInstanceOf(
        ApprovalNotPendingError,
      );
    },
  );

  it("ends a call of a dropped tool that parked on its own work when it wakes", async () => {
    let parked!: () => void;
    const isParked = new Promise<void>((resolve) => (parked = resolve));
    const nap = definePiTool({
      name: "nap",
      description: "Rest a little",
      parameters: { type: "object", properties: {} },
      replay: "safe",
      async execute(_args, api) {
        if (api.wake?.reason === "time") return { output: text("rested") };
        parked();
        return { sleep: { until: api.now() + 100 } };
      },
    });
    let listed = [search, { extension: defineExtension({ name: "naps", tools: [nap] }), tier: () => "read" }];
    const { faux, instance } = start(() => listed);
    faux.setResponses([call("nap", {}, "n-1"), fauxAssistantMessage("No rest.")]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Rest", requestId: "1" });
    await isParked;

    listed = [search];
    await instance.refreshExtensions();
    const items = await readUntil(session, isRunEnd);
    expect(toolEnd(items, "n-1")).toMatchObject({
      toolName: "nap",
      status: "error",
      error: expect.stringContaining("Tool nap is not available"),
    });
  });

  it("runs a task that a dropped extension's hook asked for to its end", async () => {
    const progress = { napped: 0, named: 0 };
    let listed = [titles(progress)];
    const { faux, instance, reports } = start(() => listed);
    faux.setResponses([fauxAssistantMessage("Hi."), fauxAssistantMessage("Again.")]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Hi", requestId: "1" });
    await readUntil(session, isRunEnd);
    await eventually(() => progress.napped === 1);

    // The task sleeps, and wakes after the refresh to a definition the instance still holds.
    listed = [search];
    await instance.refreshExtensions();
    await session.submit({ text: "Again", requestId: "2" });
    await readUntil(session, (_event, read) => runEnds(read) === 2);
    expect(progress).toEqual({ napped: 1, named: 1 });
    expect(reports).toEqual([]);
  });

  const titled = titles({ napped: 0, named: 0 });
  it.each([
    {
      what: "an extension named like the runtime's",
      extensions: [{ extension: defineExtension({ name: "runtime:desk" }) }],
    },
    { what: "two extensions of one name", extensions: [shell, { extension: defineExtension({ name: "shell" }) }] },
    {
      what: "a tool named like the agent's",
      extensions: [{ extension: defineExtension({ name: "notes", tools: [appTool("remove", "gone")] }) }],
    },
    {
      what: "a tool named like another extension's",
      extensions: [shell, { extension: defineExtension({ name: "sh", tools: [appTool("shell", "ran")] }) }],
    },
    {
      what: "a wrap of the agent's tool",
      extensions: [
        { extension: defineExtension({ name: "spy", wraps: [wrapTool(appTool("remove", "gone"), (tool) => tool)] }) },
      ],
    },
    {
      what: "two tasks of one name",
      extensions: [titled, { extension: defineExtension({ name: "renamer", tasks: titled.extension.tasks }) }],
    },
  ])("refuses, as an open does, app extensions with $what, and changes nothing", async ({ extensions }) => {
    let listed: readonly AppExtension[] = [search];
    const { faux, instance } = start(() => listed);
    const { requests, respond } = recorded([fauxAssistantMessage("Hi.")]);
    faux.setResponses(respond);
    const session = instance.session((await instance.createSession()).id);

    // An extension a partial refresh would have installed comes first.
    listed = [search, extra, ...extensions];
    const refused = await instance.refreshExtensions().catch((error: unknown) => error);
    const opening = await runtime!
      .get(desk, "bob")
      .open()
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).toEqual(opening);
    expect(Object.getPrototypeOf(refused)).toBe(Object.getPrototypeOf(opening));

    await session.submit({ text: "Hi", requestId: "1" });
    await readUntil(session, isRunEnd);
    expect(offered(requests[0]!)).toEqual(["remove", "tool_search"]);
  });

  it("rejects with the error of an `extensionsFor` that fails, and changes nothing", async () => {
    let down = false;
    const { faux, instance } = start(() => {
      if (down) throw new Error("The MCP hub is down");
      return [search];
    });
    const { requests, respond } = recorded([fauxAssistantMessage("Hi.")]);
    faux.setResponses(respond);
    const session = instance.session((await instance.createSession()).id);
    down = true;
    await expect(instance.refreshExtensions()).rejects.toThrow("The MCP hub is down");
    await session.submit({ text: "Hi", requestId: "1" });
    await readUntil(session, isRunEnd);
    expect(offered(requests[0]!)).toEqual(["remove", "tool_search"]);
  });

  it("refuses a task named like one of an extension it no longer lists, which stays installed", async () => {
    const titled = titles({ napped: 0, named: 0 });
    let listed: readonly AppExtension[] = [titled];
    const { instance } = start(() => listed);
    await instance.open();
    listed = [{ extension: defineExtension({ name: "renamer", tasks: titled.extension.tasks }) }];
    await expect(instance.refreshExtensions()).rejects.toThrow(
      "Task app.title of extension renamer is already installed",
    );
  });

  it("takes refreshes in the order they were called, the last one's extensions staying", async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const resolutions: (() => Promise<readonly AppExtension[]>)[] = [
      async () => [search],
      async () => {
        await slow;
        return [search, shell];
      },
      async () => [search, extra],
    ];
    const { faux, instance } = start(() => resolutions.shift()!());
    const { requests, respond } = recorded([fauxAssistantMessage("Hi.")]);
    faux.setResponses(respond);
    const session = instance.session((await instance.createSession()).id);

    const first = instance.refreshExtensions();
    const second = instance.refreshExtensions();
    setTimeout(release, 20);
    await Promise.all([first, second]);
    await session.submit({ text: "Hi", requestId: "1" });
    await readUntil(session, isRunEnd);
    expect(offered(requests[0]!)).toEqual(["extra", "remove", "tool_search"]);
  });

  it("does nothing while the instance is not open, and waits for an open under way", async () => {
    let resolved = 0;
    const { instance } = start(() => {
      resolved += 1;
      return [search];
    });
    await instance.refreshExtensions();
    expect({ state: instance.state, resolved }).toEqual({ state: "dormant", resolved: 0 });
    const opening = instance.open();
    await instance.refreshExtensions();
    expect({ state: instance.state, resolved }).toEqual({ state: "open", resolved: 2 });
    await opening;
  });
});
