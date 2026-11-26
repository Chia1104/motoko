// Each test expects what the README's "Delegates" says.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, StorageWrite } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { delegateOf, foldEvents } from "@chia1104/motoko-wire";
import type { AgentSessionView, StreamItem, ToolItem } from "@chia1104/motoko-wire";

import {
  ApprovalNotPendingError,
  callErrorOf,
  createAgentRuntime,
  defineAgent,
  defineDelegate,
  defineTool,
  runCall,
  scopeKey,
  SessionNotFoundError,
  SessionOwnedError,
} from "../src/index.ts";
import type {
  AgentHost,
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  StorageScope,
  ToolContext,
} from "../src/index.ts";

import {
  durableMemoryHost,
  eventually,
  fauxModels,
  follow,
  isRunEnd,
  memoryHost,
  memoryPlace,
  readUntil,
} from "./helpers.ts";
import type { MemoryPlace } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

interface Ports {
  readonly deleted: string[];
}

const lookup = defineTool({
  name: "lookup",
  description: "Look up a note",
  tier: "read",
  parameters: z.object({ key: z.string() }),
  async execute({ key }) {
    return { text: `note ${key}` };
  },
});

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

const researcher = defineAgent<Ports>({
  kind: "researcher",
  instructions: "You research notes.",
  tools: [lookup, remove],
  policy: { requiresApproval: ["write"] },
});

const research = defineDelegate({
  name: "research",
  description: "Hand a research task to the researcher",
  label: "Research",
  tier: "delegate",
  agent: researcher,
});

const note = defineTool({
  name: "note",
  description: "Write a note",
  tier: "read",
  parameters: z.object({ text: z.string() }),
  async execute({ text }) {
    return { text: `noted ${text}` };
  },
});

const notes = defineAgent<Ports>({
  kind: "notes",
  instructions: "You keep notes.",
  tools: [note, research],
});

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

function offered(messages: readonly Message[]) {
  const system = messages.filter((message): message is SystemMessage => message.role === "system");
  const tools = new Set<string>();
  for (const message of system) {
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return { prompt: JSON.stringify(system), tools: [...tools].sort() };
}

type Role = "parent" | "child";

function script(faux: ReturnType<typeof fauxModels>["faux"], steps: Record<Role, FauxResponseStep[]>) {
  const requests: Record<Role, Message[][]> = { parent: [], child: [] };
  const respond: FauxResponseFactory = async (request, options, state, model) => {
    const role: Role = offered(request.messages).prompt.includes(researcher.instructions) ? "child" : "parent";
    requests[role].push(request.messages);
    const step = steps[role].shift();
    if (step === undefined) throw new Error(`No ${role} response left`);
    return typeof step === "function" ? step(request, options, state, model) : step;
  };
  faux.setResponses(Array.from({ length: 32 }, () => respond));
  return requests;
}

const runsWith = { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" };

const delegateCall = (task: string, id = "d-1") =>
  fauxAssistantMessage(fauxToolCall("research", { task }, { id }), { stopReason: "toolUse" });

const toolCall = (name: string, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, { key: "a" }, { id }), { stopReason: "toolUse" });

function held(text: string) {
  let release!: () => void;
  let start!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (start = resolve));
  const step: FauxResponseFactory = async (_request, options) => {
    start();
    await new Promise<void>((resolve) => {
      void released.then(resolve);
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage(text);
  };
  return { step, started, release };
}

const lastOf = (requests: Message[][], index: number) => requests[index]?.at(-1);

const fold = (items: readonly StreamItem[]): AgentSessionView => foldEvents(items.map((item) => item.event));

const toolItem = (view: AgentSessionView, toolCallId: string) =>
  view.items.find((item): item is ToolItem => item.kind === "tool" && item.toolCallId === toolCallId);

async function withChild(parent: AgentSession, toolCallId = "d-1"): Promise<AgentSessionView> {
  return fold(
    await readUntil(parent, (_event, read) => {
      const item = toolItem(fold(read), toolCallId);
      return item !== undefined && delegateOf(item) !== undefined;
    }),
  );
}

const childOf = async (parent: AgentSession, toolCallId = "d-1") =>
  delegateOf(toolItem(await withChild(parent, toolCallId), toolCallId)!)!.sessionId;

type Models = ReturnType<typeof fauxModels>;

function start(host: AgentHost, models: Models, settings?: AgentRuntimeOptions<Ports>["settings"]) {
  const ports: Ports = { deleted: [] };
  runtime = createAgentRuntime({
    agents: [notes],
    host,
    models: models.models,
    ports,
    defaultModel: models.model,
    ...(settings && { settings }),
  });
  return { ports, runtime, instance: runtime.get(notes, "alice") };
}

function setup(options: { host?: AgentHost; settings?: AgentRuntimeOptions<Ports>["settings"] } = {}) {
  const models = fauxModels();
  return { faux: models.faux, models, ...start(options.host ?? memoryHost(), models, options.settings) };
}

describe("a delegate", () => {
  it("returns the sub-agent's answer as its result, and its child session is followed with its own items", async () => {
    const { faux, instance } = setup();
    const requests = script(faux, {
      parent: [delegateCall("Find a"), fauxAssistantMessage("a is apples, it says.")],
      child: [fauxAssistantMessage("a is apples")],
    });
    const parent = instance.session((await instance.createSession()).id);
    await parent.submit({ text: "What is a?", requestId: "1" });
    const view = fold(await readUntil(parent, isRunEnd));

    expect(lastOf(requests.parent, 1)).toMatchObject({
      role: "toolResult",
      toolCallId: "d-1",
      isError: false,
      content: [{ type: "text", text: "a is apples" }],
    });
    const call = toolItem(view, "d-1")!;
    expect(call).toMatchObject({ toolName: "research", label: "Research", tier: "delegate", status: "ok" });
    const delegate = delegateOf(call);
    expect(delegate).toEqual({ sessionId: expect.any(String), agent: "researcher" });

    const child = instance.session(delegate!.sessionId);
    expect(fold(await readUntil(child, isRunEnd)).items).toMatchObject([
      { kind: "user", text: "Find a" },
      { kind: "assistant", text: "a is apples" },
    ]);
    expect(await instance.listSessions()).toEqual([{ id: parent.id, createdAt: expect.any(Number) }]);
  });

  it("offers each session only its own agent's tools and instructions", async () => {
    const { faux, instance } = setup();
    const requests = script(faux, {
      parent: [delegateCall("Find a"), fauxAssistantMessage("Done.")],
      child: [fauxAssistantMessage("a is apples")],
    });
    expect(await instance.session((await instance.createSession()).id).settings()).toEqual({
      ...runsWith,
      tools: ["note", "research"],
    });
    const parent = instance.session((await instance.createSession({ tools: ["research"] })).id);
    expect(await parent.settings()).toEqual({ ...runsWith, tools: ["research"] });
    await parent.submit({ text: "What is a?", requestId: "1" });
    await readUntil(parent, isRunEnd);

    const top = offered(requests.parent[0]!);
    expect(top.tools).toEqual(["research"]);
    expect(top.prompt).toContain(notes.instructions);
    expect(top.prompt).not.toContain(researcher.instructions);
    const sub = offered(requests.child[0]!);
    expect(sub.tools).toEqual(["lookup", "remove"]);
    expect(sub.prompt).toContain(researcher.instructions);
    expect(sub.prompt).not.toContain(notes.instructions);
    expect(await instance.session(await childOf(parent)).settings()).toEqual({
      ...runsWith,
      tools: ["lookup", "remove"],
    });
  });

  it("runs the sub-agent on its own model when it names one, else on its parent's", async () => {
    const { faux, models } = fauxModels({ models: [{ id: "main" }, { id: "small" }] });
    const main = { provider: faux.provider.id, modelId: "main" };
    const small = { provider: faux.provider.id, modelId: "small" };
    const pinned = defineAgent<Ports>({ kind: "pinned", instructions: "You answer briefly.", tools: [], model: small });
    const brief = defineAgent<Ports>({
      kind: "brief",
      instructions: "You keep brief notes.",
      tools: [defineDelegate({ name: "research", description: "Research", tier: "delegate", agent: pinned })],
    });
    runtime = createAgentRuntime({ agents: [notes, brief], host: memoryHost(), models, ports: { deleted: [] } });
    const used: string[] = [];
    const reply =
      (text: string): FauxResponseFactory =>
      (_request, _options, _state, model) => {
        used.push(model.id);
        return fauxAssistantMessage(text);
      };
    for (const agent of [notes, brief]) {
      used.length = 0;
      faux.setResponses([
        (_request, _options, _state, model) => {
          used.push(model.id);
          return delegateCall("Find a");
        },
        reply("a is apples"),
        reply("Done."),
      ]);
      const instance = runtime.get(agent, "alice");
      const parent = instance.session((await instance.createSession({ model: main })).id);
      await parent.submit({ text: "What is a?", requestId: "1" });
      await readUntil(parent, isRunEnd);
      expect(used).toEqual(agent === notes ? ["main", "main", "main"] : ["main", "small", "main"]);
    }
  });

  it("shows its call running, with its child, to a client that attaches while it waits", async () => {
    const { faux, instance } = setup();
    const answer = held("a is apples");
    script(faux, { parent: [delegateCall("Find a"), fauxAssistantMessage("Done.")], child: [answer.step] });
    const parent = instance.session((await instance.createSession()).id);
    await parent.submit({ text: "What is a?", requestId: "1" });
    await answer.started;

    const view = await withChild(parent);
    expect(view).toMatchObject({ status: "running", pendingApprovals: [] });
    const call = toolItem(view, "d-1")!;
    expect(call.status).toBe("running");
    expect(delegateOf(call)).toEqual({ sessionId: expect.any(String), agent: "researcher" });

    answer.release();
    expect(toolItem(fold(await readUntil(parent, isRunEnd)), "d-1")).toMatchObject({ status: "ok" });
  });

  it("refuses submit, configure and delete on a child session as `session_owned`, and changes nothing", async () => {
    const { faux, instance } = setup();
    script(faux, {
      parent: [delegateCall("Find a"), fauxAssistantMessage("Done.")],
      child: [fauxAssistantMessage("a is apples")],
    });
    const parent = instance.session((await instance.createSession()).id);
    await parent.submit({ text: "What is a?", requestId: "1" });
    await readUntil(parent, isRunEnd);
    const child = instance.session(await childOf(parent));

    await expect(child.submit({ text: "Again", requestId: "2" })).rejects.toBeInstanceOf(SessionOwnedError);
    await expect(child.continue({ requestId: "c" })).rejects.toBeInstanceOf(SessionOwnedError);
    await expect(child.configure({ tools: null })).rejects.toBeInstanceOf(SessionOwnedError);
    await expect(child.configure({ model: null, maxTurns: 2 })).rejects.toBeInstanceOf(SessionOwnedError);
    await expect(child.delete()).rejects.toBeInstanceOf(SessionOwnedError);
    for (const call of [
      { method: "submit", params: { sessionId: child.id, text: "Again", requestId: "3" } },
      { method: "continue", params: { sessionId: child.id, requestId: "c" } },
      { method: "compact", params: { sessionId: child.id } },
      { method: "deleteSession", params: { sessionId: child.id } },
    ] as const) {
      const error = await runCall(instance, call).catch((caught: unknown) => caught);
      expect(callErrorOf(error)).toMatchObject({ code: "session_owned" });
    }
    expect(fold(await readUntil(child, isRunEnd)).items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(await child.settings()).toEqual({ ...runsWith, tools: ["lookup", "remove"] });
  });

  it("parks a sub-agent's gated call in the child, where it is decided, and then completes the parent", async () => {
    const { faux, ports, instance } = setup();
    const requests = script(faux, {
      parent: [delegateCall("Delete a"), fauxAssistantMessage("Done.")],
      child: [toolCall("remove", "rm-1"), fauxAssistantMessage("a is gone")],
    });
    const parent = instance.session((await instance.createSession()).id);
    await parent.submit({ text: "Delete a", requestId: "1" });
    const child = instance.session(await childOf(parent));
    await readUntil(child, (event) => event.type === "approval:request");
    expect(ports.deleted).toEqual([]);

    expect(await withChild(parent)).toMatchObject({ status: "running", pendingApprovals: [] });
    await expect(parent.approve([{ toolCallId: "d-1", approved: true }])).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
    await expect(parent.approve([{ toolCallId: "rm-1", approved: true }])).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );

    expect(await child.approve([{ toolCallId: "rm-1", approved: true }])).toEqual([
      { toolCallId: "rm-1", outcome: "applied" },
    ]);
    const view = fold(await readUntil(parent, isRunEnd));
    expect(ports.deleted).toEqual(["a"]);
    expect(toolItem(view, "d-1")).toMatchObject({ status: "ok" });
    expect(lastOf(requests.parent, 1)).toMatchObject({ content: [{ type: "text", text: "a is gone" }] });
    expect(fold(await readUntil(child, isRunEnd)).items).toMatchObject([
      { kind: "user", text: "Delete a" },
      { kind: "assistant" },
      { kind: "tool", toolCallId: "rm-1", status: "ok", approval: { approved: true } },
      { kind: "assistant", text: "a is gone" },
    ]);
  });

  it("is decided in the child after a close and reopen, and completes the parent exactly once", async () => {
    const place = memoryPlace();
    const { faux, ports, runtime } = setup({ host: durableMemoryHost(place) });
    const requests = script(faux, {
      parent: [delegateCall("Delete a"), fauxAssistantMessage("Done.")],
      child: [toolCall("remove", "rm-1"), fauxAssistantMessage("a is gone")],
    });
    const first = runtime.get(notes, "alice");
    const parentId = (await first.createSession()).id;
    await first.session(parentId).submit({ text: "Delete a", requestId: "1" });
    const childId = await childOf(first.session(parentId));
    await readUntil(first.session(childId), (event) => event.type === "approval:request");
    await first.close();

    const again = runtime.get(notes, "alice");
    expect(fold(await readUntil(again.session(childId), (event) => event.type === "approval:request"))).toMatchObject({
      status: "awaiting_approval",
      pendingApprovals: ["rm-1"],
    });
    await again.session(childId).approve([{ toolCallId: "rm-1", approved: true }]);
    await readUntil(again.session(parentId), isRunEnd);
    expect(ports.deleted).toEqual(["a"]);
    expect(lastOf(requests.parent, 1)).toMatchObject({ content: [{ type: "text", text: "a is gone" }] });
    expect(faux.state.callCount).toBe(4);
    await again.close();
    expect(await stored(place, notes, "alice")).toEqual({ children: 1, submissions: 1 });
  });

  it("does not gate a call that started, whatever its session's rule says by then, also across a reopen", async () => {
    const place = memoryPlace();
    const { faux, runtime } = setup({ host: durableMemoryHost(place) });
    const answer = held("ignored: the close stops this request");
    const requests = script(faux, {
      parent: [delegateCall("Find a"), fauxAssistantMessage("Done.")],
      child: [answer.step, fauxAssistantMessage("a is apples")],
    });
    const first = runtime.get(notes, "alice");
    const parentId = (await first.createSession()).id;
    await first.session(parentId).submit({ text: "What is a?", requestId: "1" });
    await answer.started;
    await first.session(parentId).configure({ requiresApproval: ["delegate"] });
    await first.close();

    const again = runtime.get(notes, "alice");
    const items = await readUntil(again.session(parentId), isRunEnd);
    expect(items.some((item) => item.event.type === "approval:request")).toBe(false);
    expect(toolItem(fold(items), "d-1")).toMatchObject({ status: "ok" });
    expect(lastOf(requests.parent, 1)).toMatchObject({ content: [{ type: "text", text: "a is apples" }] });
    await again.close();
    expect(await stored(place, notes, "alice")).toEqual({ children: 1, submissions: 1 });
  });

  it("gates a later call that reuses a finished delegate call's id, and it is decided as any other", async () => {
    const { faux, instance } = setup();
    script(faux, {
      parent: [
        delegateCall("Find a"),
        fauxAssistantMessage("a is apples."),
        fauxAssistantMessage(fauxToolCall("note", { text: "a" }, { id: "d-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Noted."),
      ],
      child: [fauxAssistantMessage("a is apples")],
    });
    const parent = instance.session((await instance.createSession({ requiresApproval: ["read"] })).id);
    await parent.submit({ text: "What is a?", requestId: "1" });
    await readUntil(parent, isRunEnd);
    await parent.submit({ text: "Note it.", requestId: "2" });
    const asked = await readUntil(
      parent,
      (event, read) => event.type === "approval:request" && read.some((item) => item.event.type === "run:end"),
    );
    expect(asked.at(-1)?.event).toMatchObject({ type: "approval:request", toolCallId: "d-1", toolName: "note" });
    expect(await parent.approve([{ toolCallId: "d-1", approved: true }])).toEqual([
      { toolCallId: "d-1", outcome: "applied" },
    ]);
    const done = fold(
      await readUntil(
        parent,
        (event, read) => isRunEnd(event) && read.filter((item) => isRunEnd(item.event)).length === 2,
      ),
    );
    expect(done.items.at(-1)).toMatchObject({ kind: "assistant", text: "Noted." });
  });

  it("is aborted with its parent: the child's run ends aborted", async () => {
    const { faux, instance } = setup();
    const answer = held("never read");
    script(faux, { parent: [delegateCall("Find a")], child: [answer.step] });
    const parent = instance.session((await instance.createSession()).id);
    await parent.submit({ text: "What is a?", requestId: "1" });
    await answer.started;
    const child = instance.session(await childOf(parent));
    const following = follow(child);

    await parent.abort();
    expect((await readUntil(parent, isRunEnd)).at(-1)?.event).toMatchObject({ type: "run:end", reason: "aborted" });
    await following.until((items) => items.some((item) => isRunEnd(item.event)));
    await following.stop();
    expect(following.items.find((item) => isRunEnd(item.event))?.event).toMatchObject({ reason: "aborted" });
    expect(fold(following.items).status).toBe("idle");
  });

  it("returns an error result when its child is aborted, and the parent's run goes on", async () => {
    const { faux, instance } = setup();
    const answer = held("never read");
    const requests = script(faux, {
      parent: [delegateCall("Find a"), fauxAssistantMessage("The researcher was stopped.")],
      child: [answer.step],
    });
    const parent = instance.session((await instance.createSession()).id);
    await parent.submit({ text: "What is a?", requestId: "1" });
    await answer.started;
    const child = instance.session(await childOf(parent));

    await child.abort();
    const view = fold(await readUntil(parent, isRunEnd));
    expect(lastOf(requests.parent, 1)).toMatchObject({ role: "toolResult", toolCallId: "d-1", isError: true });
    expect(JSON.stringify(lastOf(requests.parent, 1))).toContain("aborted");
    expect(toolItem(view, "d-1")).toMatchObject({ status: "error" });
    expect(view.items.at(-1)).toMatchObject({ kind: "assistant", text: "The researcher was stopped." });
    expect(fold(await readUntil(child, isRunEnd)).items.at(-1)).toMatchObject({ kind: "notice", reason: "aborted" });
  });

  it("is deleted with its parent: the child's run stops, its readers end, and the host erases both", async () => {
    const { host, asked } = erasingHost();
    const { faux, instance } = setup({ host });
    const answer = held("never read");
    script(faux, { parent: [delegateCall("Find a")], child: [answer.step] });
    const parent = instance.session((await instance.createSession()).id);
    await parent.submit({ text: "What is a?", requestId: "1" });
    await answer.started;
    const child = instance.session(await childOf(parent));
    const following = follow(child);
    await following.until((items) => items.some((item) => item.event.type === "user"));

    await parent.delete();
    await Promise.race([
      following.stop(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("still open")), 2_000)),
    ]);
    await expect(child.settings()).rejects.toBeInstanceOf(SessionNotFoundError);
    const error = await runCall(instance, { method: "abort", params: { sessionId: child.id } }).catch(
      (caught: unknown) => caught,
    );
    expect(callErrorOf(error)).toMatchObject({ code: "session_not_found" });
    expect(await instance.listSessions()).toEqual([]);
    await instance.close();
    expect(asked).toEqual([[Number(parent.id), Number(child.id)]]);
  });

  it("takes its own child sessions with it when its parent is deleted, parents first", async () => {
    const { host, asked } = erasingHost();
    const models = fauxModels();
    const chief = defineAgent<Ports>({
      kind: "chief",
      instructions: "You hand notes out.",
      tools: [defineDelegate({ name: "assign", description: "Assign notes", tier: "delegate", agent: notes })],
    });
    runtime = createAgentRuntime({
      agents: [chief],
      host,
      models: models.models,
      ports: { deleted: [] },
      defaultModel: models.model,
    });
    const instance = runtime.get(chief, "alice");
    const answer = held("never read");
    models.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("assign", { task: "Note a" }, { id: "a-1" }), { stopReason: "toolUse" }),
      delegateCall("Find a"),
      answer.step,
    ]);
    const top = instance.session((await instance.createSession()).id);
    await top.submit({ text: "Note a.", requestId: "1" });
    await answer.started;
    const child = instance.session(await childOf(top, "a-1"));
    const grandchild = instance.session(await childOf(child));

    await top.delete();
    await expect(child.settings()).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(grandchild.settings()).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(await instance.listSessions()).toEqual([]);
    await instance.close();
    expect(asked).toEqual([[Number(top.id), Number(child.id), Number(grandchild.id)]]);
  });
});

describe("an instance's agents", () => {
  it("refuse two definitions of one kind, wherever delegates reach them", () => {
    const { models, model } = fauxModels();
    const options = { host: memoryHost(), models, ports: { deleted: [] }, defaultModel: model };
    const impostor = defineAgent<Ports>({ kind: "researcher", instructions: "Another researcher.", tools: [] });
    const other = defineAgent<Ports>({
      kind: "other",
      instructions: "You keep other notes.",
      tools: [defineDelegate({ name: "research", description: "Research", tier: "delegate", agent: impostor })],
    });
    expect(() => createAgentRuntime({ ...options, agents: [notes, other] })).toThrow(
      new TypeError("Two agent definitions of kind `researcher`"),
    );
    expect(() => createAgentRuntime({ ...options, agents: [notes, impostor] })).toThrow(/`researcher`/);
    const twice = defineAgent<Ports>({ kind: "twice", instructions: "", tools: [research] });
    expect(() => createAgentRuntime({ ...options, agents: [notes, twice, researcher] })).not.toThrow();
  });
});

function erasingHost(place = memoryPlace()) {
  const asked: ConversationId[][] = [];
  const host: AgentHost = {
    ...durableMemoryHost(place),
    async erase(_scope: StorageScope, _lease, conversations) {
      asked.push([...conversations]);
    },
  };
  return { host, asked };
}

async function stored(place: MemoryPlace, agent: { kind: string }, name: string) {
  const storage = place.storages.get(scopeKey({ kind: agent.kind, name }))!;
  const conversations = (await storage.scanConversations({}, 100, undefined, context)).items;
  const children = conversations.filter((conversation) => conversation.owner !== undefined);
  let submissions = 0;
  for (const child of children) {
    submissions += (await storage.scanSubmissions({ conversationId: child.id }, 100, undefined, context)).items.length;
  }
  return { children: children.length, submissions };
}

function crashingHost(place: MemoryPlace, crashes: (writes: readonly StorageWrite[]) => boolean): AgentHost {
  const base = durableMemoryHost(place);
  let crashed = false;
  return {
    ...base,
    async storage(scope, lease) {
      const storage = await base.storage(scope, lease);
      return new Proxy(storage, {
        get(object, property) {
          if (property === "commit") {
            return async (...args: Parameters<typeof storage.commit>) => {
              if (!crashed && crashes(args[0].flat())) {
                crashed = true;
                throw new Error("The process died");
              }
              return object.commit(...args);
            };
          }
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
}

const makesChild = (writes: readonly StorageWrite[]) =>
  writes.some((write) => write.type === "conversation" && write.value.owner !== undefined);
const submitsTask = (writes: readonly StorageWrite[]) =>
  writes.some((write) => write.type === "submission" && write.value.requestId?.startsWith("delegate:") === true);
const after = (first: (writes: readonly StorageWrite[]) => boolean) => {
  let seen = false;
  return (writes: readonly StorageWrite[]) => {
    if (seen) return true;
    seen = first(writes);
    return false;
  };
};

describe("a delegate's call cut off by a crash", () => {
  it.each([
    ["the commit that makes the child", () => makesChild],
    ["the first commit after the child is made", () => after(makesChild)],
    ["the commit that submits the task", () => submitsTask],
    ["the first commit after the task is submitted", () => after(submitsTask)],
  ])("at %s makes one child and one submission when the instance recovers", async (_point, crashes) => {
    const place = memoryPlace();
    const settings = { retry: { baseDelayMs: 1 } };
    const models = fauxModels();
    const { faux } = models;
    start(crashingHost(place, crashes()), models, settings);
    const requests = script(faux, {
      parent: [delegateCall("Find a"), fauxAssistantMessage("Done.")],
      child: [fauxAssistantMessage("a is apples"), fauxAssistantMessage("a is apples")],
    });
    const first = runtime!.get(notes, "alice");
    const parentId = (await first.createSession()).id;
    await first.session(parentId).submit({ text: "What is a?", requestId: "1" });
    await eventually(() => first.state === "failed");
    await runtime!.close();

    const again = start(durableMemoryHost(place), models, settings).instance;
    const view = fold(await readUntil(again.session(parentId), isRunEnd));
    expect(toolItem(view, "d-1")).toMatchObject({ status: "ok" });
    expect(lastOf(requests.parent, requests.parent.length - 1)).toMatchObject({
      content: [{ type: "text", text: "a is apples" }],
    });
    await again.close();
    expect(await stored(place, notes, "alice")).toEqual({ children: 1, submissions: 1 });
  });
});
