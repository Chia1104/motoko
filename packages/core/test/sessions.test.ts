import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { foldEvents } from "@chia1104/motoko-wire";
import type { StreamItem } from "@chia1104/motoko-wire";

import {
  ApprovalNotPendingError,
  createAgentRuntime,
  defineAgent,
  defineTool,
  SessionNotFoundError,
} from "../src/index.ts";
import type { AgentHost, AgentRuntime, InstanceReport, StorageScope, ToolContext } from "../src/index.ts";

import { durableMemoryHost, eventually, fauxModels, isRunEnd, memoryHost, memoryPlace, readUntil } from "./helpers.ts";

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

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

const lookup = defineTool({
  name: "lookup",
  description: "Look up a note",
  tier: "read",
  parameters: z.object({ key: z.string() }),
  async execute({ key }) {
    return { text: `note ${key}` };
  },
});

const wait = defineTool({
  name: "wait",
  description: "Wait",
  tier: "read",
  parameters: z.object({}),
  async execute(_args, { signal }) {
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { text: "stopped" };
  },
});

const agent = defineAgent<Ports>({
  kind: "notes",
  instructions: "You keep notes.",
  tools: [remove, lookup, wait],
  policy: { requiresApproval: ["write"] },
});

function setup(options: { host?: AgentHost; reports?: InstanceReport[] } = {}) {
  const { faux, models, model } = fauxModels();
  const ports: Ports = { deleted: [] };
  runtime = createAgentRuntime({
    agents: [agent],
    host: options.host ?? memoryHost(),
    models,
    ports,
    defaultModel: model,
    ...(options.reports && { onReport: (report: InstanceReport) => options.reports!.push(report) }),
  });
  return { runtime, faux, ports };
}

const runsWith = { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" };

const toolCall = (name: string, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, { key: "a" }, { id }), { stopReason: "toolUse" });

describe("listSessions", () => {
  it("reads the sessions record and writes nothing", async () => {
    let commits = 0;
    const base = memoryHost();
    const host: AgentHost = {
      ...base,
      async storage() {
        const storage = new MemoryStorage();
        return new Proxy(storage, {
          get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (typeof value !== "function") return value;
            if (property !== "commit") return value.bind(target);
            return (...args: Parameters<Storage["commit"]>) => {
              commits += 1;
              return target.commit(...args);
            };
          },
        }) as Storage;
      },
    };
    const reports: InstanceReport[] = [];
    const { runtime } = setup({ host, reports });
    const instance = runtime.get(agent, "alice");
    const created = [await instance.createSession(), await instance.createSession(), await instance.createSession()];
    expect(commits).toBeGreaterThan(0);

    const before = commits;
    const listed = await instance.listSessions();
    expect(listed).toEqual(created);
    expect(listed.every((session) => session.createdAt > 0)).toBe(true);
    expect(await instance.listSessions()).toEqual(created);
    expect(commits).toBe(before);
    expect(reports).toEqual([]);
  });
});

describe("creating a session by a request ID", () => {
  it("returns the session the first call made, to a call made after it and to calls made at once", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "alice");
    const first = await instance.createSession({ requestId: "r-1" });
    expect(await instance.createSession({ requestId: "r-1" })).toEqual(first);

    const together = await Promise.all([1, 2, 3].map(() => instance.createSession({ requestId: "r-2" })));
    expect(together[1]).toEqual(together[0]);
    expect(together[2]).toEqual(together[0]);
    expect(await instance.listSessions()).toEqual([first, together[0]]);
  });

  it("makes a session for each request ID, and for each call without one", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "alice");
    const made = [
      await instance.createSession({ requestId: "r-1" }),
      await instance.createSession({ requestId: "r-2" }),
      await instance.createSession(),
      await instance.createSession(),
    ];
    expect(new Set(made.map(({ id }) => id)).size).toBe(4);
    expect(await instance.listSessions()).toEqual(made);
  });

  it("returns the first session after a restart, to another runtime on the same storage", async () => {
    const place = memoryPlace();
    const { runtime: before } = setup({ host: durableMemoryHost(place) });
    const first = await before.get(agent, "alice").createSession({ requestId: "r-1" });
    await before.close();

    const { runtime: after } = setup({ host: durableMemoryHost(place) });
    const instance = after.get(agent, "alice");
    expect(await instance.createSession({ requestId: "r-1" })).toEqual(first);
    expect(await instance.listSessions()).toEqual([first]);
  });

  it("returns the first session as it is to a retry that asks for other settings", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "alice");
    const first = await instance.createSession({ requestId: "r-1", tools: ["lookup"], requiresApproval: ["read"] });
    expect(await instance.createSession({ requestId: "r-1", tools: ["remove"], requiresApproval: [] })).toEqual(first);
    expect(await instance.session(first.id).settings()).toEqual({
      ...runsWith,
      tools: ["lookup"],
      requiresApproval: ["read"],
    });
    expect(await instance.listSessions()).toEqual([first]);
  });

  it("forgets the request ID of a deleted session: a retry makes a new one, and the deleted one stays gone", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "alice");
    const deleted = await instance.createSession({ requestId: "r-1" });
    await instance.session(deleted.id).delete();

    const again = await instance.createSession({ requestId: "r-1" });
    expect(again.id).not.toBe(deleted.id);
    expect(await instance.createSession({ requestId: "r-1" })).toEqual(again);
    expect(await instance.listSessions()).toEqual([again]);
    await expect(instance.session(deleted.id).settings()).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("a session's tools", () => {
  it("offers only the tools it selects: a call of another one never runs", async () => {
    const { runtime, faux, ports } = setup();
    const instance = runtime.get(agent, "t");
    const { id } = await instance.createSession({ tools: ["lookup"] });
    const session = instance.session(id);
    expect(await session.settings()).toEqual({ ...runsWith, tools: ["lookup"] });

    faux.setResponses([toolCall("remove", "rm-1"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Delete a", requestId: "1" });
    const items = await readUntil(session, isRunEnd);
    const view = foldEvents(items.map((item) => item.event));
    expect(items.some((item) => item.event.type === "approval:request")).toBe(false);
    expect(items.find((item) => item.event.type === "tool:end")?.event).toMatchObject({ status: "error" });
    expect(view.status).toBe("idle");
    expect(ports.deleted).toEqual([]);
  });

  it("changes its tools with configure, `{ remove }` drops some, and null gives back all of them", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "t");
    const session = instance.session((await instance.createSession()).id);
    expect(await session.settings()).toEqual({ ...runsWith, tools: ["remove", "lookup", "wait"] });
    await session.configure({ tools: { remove: ["remove"] } });
    expect(await session.settings()).toEqual({ ...runsWith, tools: ["lookup", "wait"] });
    await session.configure({ tools: null });
    expect(await session.settings()).toEqual({ ...runsWith, tools: ["remove", "lookup", "wait"] });
  });

  it("refuses a tool the agent does not have, and changes nothing", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "t");
    await expect(instance.createSession({ tools: ["clock"] })).rejects.toBeInstanceOf(TypeError);
    expect(await instance.listSessions()).toEqual([]);
    const session = instance.session((await instance.createSession()).id);
    await expect(session.configure({ tools: { remove: ["clock"] } })).rejects.toBeInstanceOf(TypeError);
    expect(await session.settings()).toEqual({ ...runsWith, tools: ["remove", "lookup", "wait"] });
  });
});

describe("a session's approval rule", () => {
  it("gates what the session's rule names, which the agent's policy alone would run", async () => {
    const { runtime, faux } = setup();
    const instance = runtime.get(agent, "r");
    const { id } = await instance.createSession({ requiresApproval: { add: ["read"] } });
    const session = instance.session(id);
    expect(await session.settings()).toMatchObject({ requiresApproval: { add: ["read"] } });

    faux.setResponses([toolCall("lookup", "lk-1"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Look a up", requestId: "1" });
    await readUntil(session, (event) => event.type === "approval:request");
    expect(await session.approve([{ toolCallId: "lk-1", approved: true }])).toEqual([
      { toolCallId: "lk-1", outcome: "applied" },
    ]);
    const items = await readUntil(session, isRunEnd);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
  });

  it("runs without a decision what the session's rule no longer gates", async () => {
    const { runtime, faux, ports } = setup();
    const instance = runtime.get(agent, "r");
    const session = instance.session((await instance.createSession({ requiresApproval: [] })).id);
    faux.setResponses([toolCall("remove", "rm-1"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Delete a", requestId: "1" });
    const items = await readUntil(session, isRunEnd);
    expect(items.some((item) => item.event.type === "approval:request")).toBe(false);
    expect(ports.deleted).toEqual(["a"]);

    await session.configure({ requiresApproval: null });
    expect(await session.settings()).toEqual({ ...runsWith, tools: ["remove", "lookup", "wait"] });
    faux.setResponses([toolCall("remove", "rm-2"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Delete a", requestId: "2" });
    await readUntil(session, (event) => event.type === "approval:request" && event.toolCallId === "rm-2");
  });

  it("keeps the question of a call that parked before the rule changed, and takes its decision", async () => {
    const { runtime, faux, ports } = setup();
    const instance = runtime.get(agent, "r");
    const session = instance.session((await instance.createSession()).id);
    faux.setResponses([toolCall("remove", "rm-1"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Delete a", requestId: "1" });
    await readUntil(session, (event) => event.type === "approval:request");
    await session.configure({ requiresApproval: [] });

    const late = await readUntil(session, (event) => event.type === "approval:request");
    expect(late.at(-1)?.event).toMatchObject({ toolCallId: "rm-1" });
    await session.approve([{ toolCallId: "rm-1", approved: true }]);
    const items = await readUntil(session, isRunEnd);
    expect(items.some((item) => item.event.type === "approval:resolved")).toBe(true);
    expect(ports.deleted).toEqual(["a"]);
  });

  it("refuses a tier none of the agent's tools has", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "r");
    await expect(instance.createSession({ requiresApproval: ["admin"] })).rejects.toBeInstanceOf(TypeError);
    const session = instance.session((await instance.createSession()).id);
    await expect(session.configure({ requiresApproval: { remove: ["admin"] } })).rejects.toBeInstanceOf(TypeError);
    expect(await session.settings()).toEqual({ ...runsWith, tools: ["remove", "lookup", "wait"] });
  });

  it("decides a batch whole: one call not waiting applies none of it", async () => {
    const { runtime, faux, ports } = setup();
    const instance = runtime.get(agent, "r");
    const session = instance.session((await instance.createSession()).id);
    faux.setResponses([toolCall("remove", "rm-1"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Delete a", requestId: "1" });
    await readUntil(session, (event) => event.type === "approval:request");
    await expect(
      session.approve([
        { toolCallId: "rm-1", approved: true },
        { toolCallId: "ghost", approved: true },
      ]),
    ).rejects.toBeInstanceOf(ApprovalNotPendingError);
    expect(ports.deleted).toEqual([]);
    expect(await session.approve([{ toolCallId: "rm-1", approved: true }])).toEqual([
      { toolCallId: "rm-1", outcome: "applied" },
    ]);
    await readUntil(session, isRunEnd);
    expect(ports.deleted).toEqual(["a"]);
  });
});

describe("what a session runs with", () => {
  const other = { provider: "faux", modelId: "faux-2" };
  const allTools = ["remove", "lookup", "wait"];

  function twoModels(options: { defaultModel?: boolean } = {}) {
    const { faux, models, model } = fauxModels({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
    runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      models,
      ports: { deleted: [] },
      ...(options.defaultModel !== false && { defaultModel: model }),
    });
    const asked: string[] = [];
    const answer =
      (text: string): FauxResponseStep =>
      (_context, _options, _state, requested) => {
        asked.push(requested.id);
        return fauxAssistantMessage(text);
      };
    return { instance: runtime.get(agent, "m"), faux, asked, answer };
  }

  it("takes a model, a thinking level and a turn limit when made, and reads them back", async () => {
    const { instance } = twoModels();
    const { id } = await instance.createSession({ model: other, thinkingLevel: "high", maxTurns: 3 });
    expect(await instance.session(id).settings()).toEqual({
      model: other,
      thinkingLevel: "high",
      maxTurns: 3,
      tools: allTools,
    });
  });

  it("changes them with configure, and null puts back what a new session gets", async () => {
    const { instance, faux, asked, answer } = twoModels();
    const session = instance.session((await instance.createSession()).id);
    await session.configure({ model: other, thinkingLevel: "low", maxTurns: 2 });
    expect(await session.settings()).toEqual({ model: other, thinkingLevel: "low", maxTurns: 2, tools: allTools });
    faux.setResponses([answer("On two.")]);
    await session.submit({ text: "Hi", requestId: "1" });
    await readUntil(session, isRunEnd);

    await session.configure({ model: null, thinkingLevel: null, maxTurns: null });
    expect(await session.settings()).toEqual({ ...runsWith, tools: allTools });
    faux.setResponses([answer("On one.")]);
    await session.submit({ text: "Hi again", requestId: "2" });
    await readUntil(session, (_event, items) => items.filter((item) => isRunEnd(item.event)).length === 2);
    expect(asked).toEqual(["faux-2", "faux-1"]);
  });

  it("refuses `model: null` when neither the agent nor the runtime has a model to put back", async () => {
    const { instance } = twoModels({ defaultModel: false });
    const session = instance.session((await instance.createSession({ model: other })).id);
    await expect(session.configure({ model: null })).rejects.toBeInstanceOf(TypeError);
    expect((await session.settings()).model).toEqual(other);
  });

  it("ends a run at its turn limit, once the round that reaches it has run its tools", async () => {
    const { runtime, faux } = setup();
    const instance = runtime.get(agent, "l");
    const session = instance.session((await instance.createSession({ maxTurns: 1 })).id);
    faux.setResponses([toolCall("lookup", "l-1"), toolCall("lookup", "l-2"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Look a up twice", requestId: "1" });
    const items = await readUntil(session, isRunEnd);
    expect(items.filter((item) => item.event.type === "tool:end").map((item) => item.event)).toMatchObject([
      { toolCallId: "l-1", status: "ok" },
    ]);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "error", code: "turn_limit", error: "1 turn" });
    expect(faux.getPendingResponseCount()).toBe(2);
  });

  it("refuses a turn limit that is not a whole number 1 or more, and changes nothing", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "b");
    await expect(instance.createSession({ maxTurns: 0 })).rejects.toBeInstanceOf(RangeError);
    expect(await instance.listSessions()).toEqual([]);
    const session = instance.session((await instance.createSession()).id);
    for (const maxTurns of [0, 1.5]) {
      await expect(
        session.configure({ maxTurns, thinkingLevel: "high", tools: ["lookup"], requiresApproval: ["read"] }),
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(await session.settings()).toEqual({ ...runsWith, tools: allTools });
  });
});

async function nextUntil(
  reader: AsyncIterator<StreamItem>,
  stop: (result: IteratorResult<StreamItem>) => boolean,
): Promise<void> {
  let result = await reader.next();
  while (!stop(result)) result = await reader.next();
}

function erasingHost(place = memoryPlace(), failing: { now: boolean } = { now: false }) {
  const asked: ConversationId[][] = [];
  const host: AgentHost = {
    ...durableMemoryHost(place),
    async erase(_scope: StorageScope, lease, conversations) {
      if (lease.signal.aborted) throw new Error("erase without the lease");
      asked.push([...conversations]);
      if (failing.now) throw new Error("disk full");
    },
  };
  return { host, asked };
}

describe("deleting a session", () => {
  it("stops its run, ends its readers and hides it at once; the others stay", async () => {
    const { host, asked } = erasingHost();
    const { runtime, faux } = setup({ host });
    const instance = runtime.get(agent, "d");
    const kept = await instance.createSession();
    const doomed = await instance.createSession();
    const session = instance.session(doomed.id);
    faux.setResponses([toolCall("wait", "w-1"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Wait", requestId: "1" });
    const reader = session.events()[Symbol.asyncIterator]();
    await nextUntil(reader, (result) => result.value?.event.type === "tool:start");
    const ended = nextUntil(reader, (result) => result.done === true).then(() => "ended");

    await session.delete();
    const timeout = new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000));
    expect(await Promise.race([ended, timeout])).toBe("ended");
    expect(await instance.listSessions()).toEqual([kept]);
    await expect(session.submit({ text: "Again", requestId: "2" })).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(session.settings()).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(session.delete()).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(asked).toEqual([]);
  });

  it("asks the host to erase it once the storage is closed, and again at the next close until it is gone", async () => {
    const place = memoryPlace();
    const failing = { now: true };
    const { host, asked } = erasingHost(place, failing);
    const reports: InstanceReport[] = [];
    const { runtime } = setup({ host, reports });
    const instance = runtime.get(agent, "d");
    const { id } = await instance.createSession();
    await instance.session(id).delete();
    await instance.close();
    expect(asked).toEqual([[Number(id)]]);
    expect(reports).toMatchObject([{ source: "runtime", kind: "erase_failed" }]);

    failing.now = false;
    const again = runtime.get(agent, "d");
    expect(await again.listSessions()).toEqual([]);
    await again.close();
    expect(asked).toEqual([[Number(id)], [Number(id)]]);
  });

  it("only hides it on a host that cannot erase", async () => {
    const reports: InstanceReport[] = [];
    const { runtime } = setup({ host: durableMemoryHost(), reports });
    const instance = runtime.get(agent, "d");
    const { id } = await instance.createSession();
    await instance.session(id).delete();
    await instance.close();
    expect(await runtime.get(agent, "d").listSessions()).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("stops what the session's run was doing before it hides it", async () => {
    const { runtime, faux } = setup();
    const instance = runtime.get(agent, "d");
    const session = instance.session((await instance.createSession()).id);
    faux.setResponses([toolCall("wait", "w-1"), fauxAssistantMessage("Done.")]);
    await session.submit({ text: "Wait", requestId: "1" });
    await readUntil(session, (event) => event.type === "tool:start");
    await session.delete();
    await eventually(() => runtime.inspect().instances.every((held) => held.operations === 0));
    expect(faux.state.callCount).toBe(1);
  });
});
