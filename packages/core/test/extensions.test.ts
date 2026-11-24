// The app's pi-durable extensions driven through the runtime, on the faux provider: `extensionsFor` hands each
// instance its extensions when it opens. Each test expects what the README's "App extensions" says: the app's tools
// run under the approval gate with the tiers the app gives them, a tool without one always asks, a session's tools
// never turn them off, names that would run something in an agent's tool's place keep the instance from opening, a
// failed `extensionsFor` fails the open and loses no question, a sub-agent selects only the extensions that name its
// kind, an `afterRun` task keeps the session busy after its answer, and an app tool parked on its own work asks nothing.

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

import {
  ApprovalNotPendingError,
  createAgentRuntime,
  defineAgent,
  defineDelegate,
  defineTool,
  SessionBusyError,
} from "../src/index.ts";
import type { AgentHost, AgentRuntime, AppExtension, ExtensionsResolver } from "../src/index.ts";

import { durableMemoryHost, fauxModels, isRunEnd, memoryHost, memoryPlace, readUntil, runEnds } from "./helpers.ts";

interface Ports {
  readonly deleted: string[];
}

const remove = defineTool({
  name: "remove",
  description: "Delete a note",
  tier: "write",
  parameters: z.object({ key: z.string() }),
  async execute({ key }, { ports }: { ports: Ports }) {
    ports.deleted.push(key);
    return { text: `deleted ${key}` };
  },
});

const lookup = defineTool({
  name: "lookup",
  description: "Look up a note",
  tier: "read",
  parameters: z.object({ key: z.string() }),
  async execute({ key }) {
    return { text: `note ${key}` };
  },
});

const helper = defineAgent<Ports>({ kind: "helper", instructions: "You help the desk.", tools: [lookup] });

const desk = defineAgent<Ports>({
  kind: "desk",
  instructions: "You run the desk.",
  tools: [
    remove,
    defineDelegate({ name: "help", description: "Hand a task to the helper", tier: "read", agent: helper }),
  ],
  policy: { requiresApproval: ["network", "write"] },
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

const search = createToolSearchExtension();
/** Deferred, so the model is offered it only once `tool_search` loads it. */
const forecast = defineExtension({
  name: "forecast",
  tools: [appTool("weather", "sunny", { description: "The weather in a city", deferred: true })],
});
const shell = defineExtension({ name: "shell", tools: [appTool("shell", "ran")] });

/** Tool search reads, the forecast goes out to the network, and the shell has no tier. */
const app: AppExtension[] = [
  { extension: search, tier: () => "read" },
  { extension: forecast, tier: () => "network" },
  { extension: shell },
];

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

function start(
  options: {
    host?: AgentHost;
    extensions?: readonly AppExtension[] | ExtensionsResolver;
    models?: ReturnType<typeof fauxModels>;
  } = {},
) {
  const models = options.models ?? fauxModels();
  const extensions = options.extensions ?? app;
  runtime = createAgentRuntime({
    agents: [desk],
    host: options.host ?? memoryHost(),
    models: models.models,
    ports: { deleted: [] },
    defaultModel: models.model,
    extensionsFor: typeof extensions === "function" ? extensions : () => extensions,
  });
  return { faux: models.faux, instance: runtime.get(desk, "alice") };
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

const isAsked = (event: AgentWireEvent) => event.type === "approval:request";
const asked = (items: readonly StreamItem[]) =>
  items.flatMap(({ event }) => (event.type === "approval:request" ? [event] : []));

describe("app extensions", () => {
  it("runs the app's tools under the gate, with the tiers the app gives them", async () => {
    const { faux, instance } = start();
    const { requests, respond } = recorded([
      call("tool_search", { query: "weather" }, "ts-1"),
      call("weather", { city: "Taipei" }, "w-1"),
      fauxAssistantMessage("Sunny in Taipei."),
    ]);
    faux.setResponses(respond);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Weather?", requestId: "1" });

    // `tool_search` is a read, which the policy runs; the forecast goes out to the network, which it gates.
    expect(asked(await readUntil(session, isAsked))).toEqual([
      { type: "approval:request", toolCallId: "w-1", toolName: "weather", tier: "network", args: { city: "Taipei" } },
    ]);
    expect(offered(requests[0]!)).toEqual(["help", "remove", "shell", "tool_search"]);
    expect(offered(requests[1]!)).toEqual(["help", "remove", "shell", "tool_search", "weather"]);

    await session.approve([{ toolCallId: "w-1", approved: true }]);
    const items = await readUntil(session, isRunEnd);
    const view = fold(items);
    expect(toolItem(view, "ts-1")).toMatchObject({ toolName: "tool_search", tier: "read", status: "ok" });
    expect(toolItem(view, "w-1")).toMatchObject({ toolName: "weather", tier: "network", status: "ok" });
    expect(items.at(-1)?.event).toMatchObject({ type: "run:end", reason: "done" });
    expect(asked(items)).toHaveLength(1);
  });

  it("asks before every call of a tool the app gives no tier, whatever the session's rule says", async () => {
    const { faux, instance } = start();
    // No rule takes the question away: `unknown` is no tier a rule can name.
    await expect(instance.createSession({ requiresApproval: { remove: ["unknown"] } })).rejects.toThrow(
      "`requiresApproval.remove` names tier `unknown`, which no tool of `desk` has",
    );
    faux.setResponses([call("shell", {}, "sh-1"), fauxAssistantMessage("Done.")]);
    const session = instance.session((await instance.createSession({ requiresApproval: [] })).id);
    await session.submit({ text: "Run it", requestId: "1" });
    expect(asked(await readUntil(session, isAsked))).toMatchObject([{ toolName: "shell", tier: "unknown" }]);
    await session.approve([{ toolCallId: "sh-1", approved: true }]);
    expect(toolItem(fold(await readUntil(session, isRunEnd)), "sh-1")).toMatchObject({ status: "ok" });
  });

  it("takes the app's tiers in a session's rule", async () => {
    const { faux, instance } = start();
    faux.setResponses([call("tool_search", { query: "weather" }, "ts-1"), fauxAssistantMessage("Done.")]);
    const session = instance.session((await instance.createSession({ requiresApproval: ["read"] })).id);
    expect(await session.settings()).toMatchObject({ requiresApproval: ["read"] });
    await session.submit({ text: "Find it", requestId: "1" });
    expect(asked(await readUntil(session, isAsked))).toMatchObject([{ toolName: "tool_search", tier: "read" }]);
    await session.configure({ requiresApproval: { remove: ["network"] } });
  });

  it("keeps the app's tools on whatever agent tools a session selects", async () => {
    const { faux, instance } = start();
    const { requests, respond } = recorded([
      call("tool_search", { query: "weather" }, "ts-1"),
      fauxAssistantMessage("Done."),
      fauxAssistantMessage("Again."),
    ]);
    faux.setResponses(respond);
    const session = instance.session((await instance.createSession({ tools: ["remove"] })).id);
    expect(await session.settings()).toMatchObject({ tools: ["remove"] });
    await session.submit({ text: "Find it", requestId: "1" });
    expect(toolItem(fold(await readUntil(session, isRunEnd)), "ts-1")).toMatchObject({ status: "ok" });
    expect(offered(requests[0]!)).toEqual(["remove", "shell", "tool_search"]);

    await session.configure({ tools: { remove: ["remove"] } });
    await session.submit({ text: "Again", requestId: "2" });
    await readUntil(session, (_event, read) => runEnds(read) === 2);
    expect(offered(requests[2]!)).toEqual(["help", "shell", "tool_search", "weather"]);
  });

  it.each([
    {
      what: "an extension named like the runtime's",
      extensions: [{ extension: defineExtension({ name: "runtime:desk" }) }],
      message: "App extension `runtime:desk` takes a name of the runtime's: `runtime:` names are Motoko's",
    },
    {
      what: "two extensions of one name",
      extensions: [{ extension: forecast }, { extension: defineExtension({ name: "forecast" }) }],
      message: "Two app extensions are named `forecast`",
    },
    {
      what: "a tool named like the agent's",
      extensions: [{ extension: defineExtension({ name: "notes", tools: [appTool("remove", "gone")] }) }],
      message: "App extension `notes` has tool `remove`, which agent `desk` has",
    },
    {
      what: "a tool named like a sub-agent's",
      extensions: [{ extension: defineExtension({ name: "notes", tools: [appTool("lookup", "found")] }) }],
      message: "App extension `notes` has tool `lookup`, which agent `helper` has",
    },
    {
      what: "a tool named like another extension's",
      extensions: [
        { extension: forecast },
        { extension: defineExtension({ name: "sky", tools: [appTool("weather", "rain")] }) },
      ],
      message: "App extensions `forecast` and `sky` both have tool `weather`",
    },
    {
      what: "a wrap of the agent's tool",
      extensions: [
        { extension: defineExtension({ name: "spy", wraps: [wrapTool(appTool("remove", "gone"), (tool) => tool)] }) },
      ],
      message: "App extension `spy` wraps tool `remove` of agent `desk`",
    },
  ])("does not open an instance whose app extensions have $what", async ({ extensions, message }) => {
    const { instance } = start({ extensions });
    const error = await instance.createSession().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe(message);
  });

  it("fails the open when `extensionsFor` fails, and keeps a call waiting at the gate for a later open", async () => {
    const place = memoryPlace();
    const models = fauxModels();
    let down = false;
    const extensionsFor = async () => {
      if (down) throw new Error("The MCP hub is down");
      return app;
    };
    let { faux, instance } = start({ host: durableMemoryHost(place), extensions: extensionsFor, models });
    faux.setResponses([call("shell", {}, "sh-1"), fauxAssistantMessage("Done.")]);
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Run it", requestId: "1" });
    await readUntil(instance.session(id), isAsked);
    await runtime!.close();

    // An open without the shell would end the call that waits for it: it does not open at all.
    down = true;
    ({ instance } = start({ host: durableMemoryHost(place), extensions: extensionsFor, models }));
    await expect(instance.session(id).approve([{ toolCallId: "sh-1", approved: true }])).rejects.toThrow(
      "The MCP hub is down",
    );

    down = false;
    expect(await instance.session(id).approve([{ toolCallId: "sh-1", approved: true }])).toEqual([
      { toolCallId: "sh-1", outcome: "applied" },
    ]);
    expect(toolItem(fold(await readUntil(instance.session(id), isRunEnd)), "sh-1")).toMatchObject({ status: "ok" });
  });

  it.each([
    { agents: undefined, child: ["lookup"] },
    { agents: ["desk", "helper"], child: ["lookup", "tool_search"] },
  ])("gives a sub-agent's session the app's extensions that name its kind: $agents", async ({ agents, child }) => {
    const { faux, instance } = start({
      extensions: [{ extension: search, tier: () => "read", ...(agents !== undefined && { agents }) }],
    });
    const { requests, respond } = recorded([
      call("help", { task: "Find a" }, "d-1"),
      fauxAssistantMessage("a is apples"),
      fauxAssistantMessage("Done."),
    ]);
    faux.setResponses(respond);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "What is a?", requestId: "1" });
    await readUntil(session, isRunEnd);
    expect(offered(requests[0]!)).toEqual(["help", "remove", "tool_search"]);
    expect(offered(requests[1]!)).toEqual(child);
  });

  it("keeps the session busy after its answer while an `afterRun` task of the app's runs", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let began!: () => void;
    const begun = new Promise<void>((resolve) => (began = resolve));
    const done = { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
    const title = defineTask<null, { phase: "name" }, null>({
      name: "app.title",
      version: 1,
      initial: () => ({ phase: "name" }),
      phases: {
        async name(_task, runtime, context) {
          began();
          await released;
          await runtime.commit(async () => done, context);
        },
      },
      async abort(_task, runtime, context) {
        await runtime.commit(async () => done, context);
      },
    });
    const titles = defineExtension({
      name: "titles",
      tasks: [title],
      hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [hookTask(title, null)] }) })],
    });
    const { faux, instance } = start({ extensions: [{ extension: titles }] });
    faux.setResponses([fauxAssistantMessage("Hi."), fauxAssistantMessage("Later.")]);
    const session = instance.session((await instance.createSession()).id);
    try {
      await session.submit({ text: "Hi", requestId: "1" });
      await readUntil(session, isRunEnd);
      await begun;

      // The answer is out, and the session still runs the task its run asked for.
      await expect(session.submit({ text: "Now", requestId: "2", whenBusy: "reject" })).rejects.toBeInstanceOf(
        SessionBusyError,
      );
      await session.submit({ text: "Later", requestId: "3" });
      const waiting = await readUntil(
        session,
        (_event, read) => runEnds(read) === 1 && fold(read).queued?.length === 1,
      );
      expect(fold(waiting)).toMatchObject({ status: "idle", queued: [{ text: "Later" }] });
    } finally {
      release();
    }
    const view = fold(await readUntil(session, (_event, read) => runEnds(read) === 2));
    expect(view.items.filter((item) => item.kind === "assistant")).toMatchObject([{ text: "Hi." }, { text: "Later." }]);
  });

  it("asks nothing of an app tool's call that parked on its own work, and takes no decision for it", async () => {
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
        return { sleep: { until: api.now() + 200 } };
      },
    });
    const { faux, instance } = start({
      extensions: [{ extension: defineExtension({ name: "naps", tools: [nap] }), tier: () => "read" }],
    });
    faux.setResponses([call("nap", {}, "n-1"), fauxAssistantMessage("Rested.")]);
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Rest", requestId: "1" });
    await isParked;

    const reading = readUntil(session, isRunEnd);
    let ended = false;
    void reading.then(() => (ended = true));
    while (!ended) {
      await expect(session.approve([{ toolCallId: "n-1", approved: true }])).rejects.toBeInstanceOf(
        ApprovalNotPendingError,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const items = await reading;
    expect(asked(items)).toEqual([]);
    expect(toolItem(fold(items), "n-1")).toMatchObject({ tier: "read", status: "ok" });
  });
});
