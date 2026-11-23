import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { foldEvents } from "@chia1104/motoko-wire";

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

/** Runs until its call is stopped. */
const wait = defineTool({
  name: "wait",
  description: "Wait",
  tier: "read",
  parameters: z.object({}),
  async execute(_args, { signal }) {
    // A call that starts while its instance closes finds its signal aborted already.
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
        // SAFETY: the proxy forwards every member; only `commit` is counted on its way through.
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
    expect(await instance.session(first.id).settings()).toEqual({ tools: ["lookup"], requiresApproval: ["read"] });
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
    expect(await session.settings()).toEqual({ tools: ["lookup"] });

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
    expect(await session.settings()).toEqual({ tools: ["remove", "lookup", "wait"] });
    await session.configure({ tools: { remove: ["remove"] } });
    expect(await session.settings()).toEqual({ tools: ["lookup", "wait"] });
    await session.configure({ tools: null });
    expect(await session.settings()).toEqual({ tools: ["remove", "lookup", "wait"] });
  });

  it("refuses a tool the agent does not have, and changes nothing", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "t");
    await expect(instance.createSession({ tools: ["clock"] })).rejects.toBeInstanceOf(TypeError);
    expect(await instance.listSessions()).toEqual([]);
    const session = instance.session((await instance.createSession()).id);
    await expect(session.configure({ tools: { remove: ["clock"] } })).rejects.toBeInstanceOf(TypeError);
    expect(await session.settings()).toEqual({ tools: ["remove", "lookup", "wait"] });
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

    // Back to the agent's policy: `write` waits again.
    await session.configure({ requiresApproval: null });
    expect(await session.settings()).toEqual({ tools: ["remove", "lookup", "wait"] });
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

    // A client that comes now still sees the question.
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
    expect(await session.settings()).toEqual({ tools: ["remove", "lookup", "wait"] });
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

/** A host on `place` whose `erase` records what it is asked to erase, failing while `failing` says so. */
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
    while ((await reader.next()).value?.event.type !== "tool:start") {
      // Read up to the running call.
    }
    const ended = (async () => {
      while ((await reader.next()).done !== true) {
        // What the abort committed, if anything.
      }
      return "ended";
    })();

    await session.delete();
    // The reader's stream ended by itself, with no signal of its own.
    const timeout = new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000));
    expect(await Promise.race([ended, timeout])).toBe("ended");
    expect(await instance.listSessions()).toEqual([kept]);
    await expect(session.submit({ text: "Again", requestId: "2" })).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(session.settings()).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(session.delete()).rejects.toBeInstanceOf(SessionNotFoundError);
    // Nothing is erased while the storage is open.
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

    // A memory storage cannot erase it, so it is still there: the next close asks again.
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
    // The aborted run asked for no other reply.
    expect(faux.state.callCount).toBe(1);
  });
});
