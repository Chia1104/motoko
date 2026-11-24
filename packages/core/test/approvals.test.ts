// The approval gate driven through its own interface, on a real pi-durable Harness over
// MemoryStorage: the agent's extension installs the gate, as the runtime does, the faux provider asks
// for the calls, and each test decides them with `decide`. Each test expects what the README's
// "Durable approval" says: a gated call waits for its decision, an approved one runs, a declined one
// hands the model the operator's words as its result, and the decision is recorded with the arguments
// the gate saw. A nested call, one a tool makes through `executeTool()`, is decided the same way, and a
// declined one hands the operator's words to the tool that made it; one no decision reaches by its
// deadline fails for that tool, while a call of the model's has none.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool as definePiTool,
  Harness,
  hook,
  LiveDoc,
  MemoryStorage,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { ConversationId, Extension, JsonObject, NestedToolSlot, ToolSlot } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { decide, decisionsOf, isGated } from "../src/engine/approvals.ts";
import type { ApprovalDecision } from "../src/engine/approvals.ts";
import { agentExtensions } from "../src/engine/bind.ts";
import { appExtensions } from "../src/engine/extensions.ts";
import type { AppExtension } from "../src/engine/extensions.ts";
import { SessionsDoc } from "../src/engine/sessions.ts";
import type { ApprovalRule } from "../src/engine/sessions.ts";
import { ApprovalNotPendingError, defineAgent, defineTool } from "../src/index.ts";
import type { AgentDefinition, AgentDefinitionInput, ToolContext } from "../src/index.ts";

import { fauxModels } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

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

type Rule = NonNullable<AgentDefinitionInput<Ports>["policy"]>["requiresApproval"];
/** The notes agent under `requiresApproval`. */
const notesUnder = (requiresApproval: Rule) =>
  defineAgent<Ports>({
    kind: "notes",
    instructions: "You keep notes.",
    tools: [remove, lookup],
    policy: { requiresApproval },
  });
const notes = notesUnder(["write"]);

/** A tool of another extension, which the runtime knows no tier of: the agent does not have it. */
const clock = defineExtension({
  name: "clock",
  tools: [
    definePiTool({
      name: "clock",
      description: "Tell the time",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { output: [{ type: "text", text: "noon" }] };
      },
    }),
  ],
});

/**
 * A hook that runs before the gate and gives every call the arguments `rewrite` makes at each pass of the chain, as no
 * app hook the runtime installs does: it holds an app hook's first rewrite.
 */
const rewriting = (rewrite: (pass: number) => JsonObject) => {
  let pass = 0;
  return defineExtension({
    name: "rewrite",
    hooks: [hook(ToolTask, { beforeTool: () => ({ arguments: rewrite((pass += 1)) }) })],
  });
};

/** The app's extensions `app` of an instance of `agent`: none by default. */
const appOf = (agent: AgentDefinition<Ports>, app: readonly AppExtension[] = []) =>
  appExtensions({ kind: agent.kind, name: "a" }, new Map([[agent.kind, agent]]), app);
const noApp = (agent: AgentDefinition<Ports>) => appOf(agent);

/**
 * The app's `script`, at tier `exec`, whose call makes its first nested call, `<its id>/1`, of the agent's `remove` on
 * note `a`, and hands the model what the nested call returned, or why it failed: replay-safe, as a code mode call is,
 * so it runs again after a restart and finds its nested call again.
 */
const scripting: AppExtension = {
  extension: defineExtension({
    name: "script",
    tools: [
      definePiTool({
        name: "script",
        description: "Run a script",
        parameters: { type: "object", properties: {} },
        replay: "safe",
        async execute(_args, api, context) {
          const nested = await api.executeTool("remove", { key: "a" }, context);
          // As a code mode script reads it: the output, or why it failed.
          const why = nested.diagnostics.filter(({ severity }) => severity === "error").map(({ message }) => message);
          const text = nested.isError ? why.join("\n") : String(nested.structuredOutput);
          return { output: [{ type: "text", text }], isError: nested.isError };
        },
      }),
    ],
  }),
  tier: () => "exec",
};

/** Whether a call of tool `name` in a session of `agent` waits for approval under `rule`, as the runtime judges it. */
const gatedIn = (agent: AgentDefinition<Ports>, name: string, rule?: ApprovalRule) =>
  isGated(agent, noApp(agent).catalog.tool(agent.kind, name), rule);

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close(context)));
});

/**
 * A conversation of `agent` whose first reply asks for `call`, and what the model reads after it. With `rule`, the
 * conversation is a session with that approval rule of its own, recorded as the runtime records it. The extensions
 * `more` run before the agent's, as an app's do, and the app's extensions `app` too, with the tiers they give. A nested
 * call waits `nestedApprovalTimeoutMs` for a decision, an hour by default, as the runtime's.
 */
async function conversationOf(
  agent: AgentDefinition<Ports>,
  call: { name: string; id: string },
  {
    rule,
    more = [],
    app = [],
    nestedApprovalTimeoutMs = 3_600_000,
  }: { rule?: ApprovalRule; more?: Extension[]; app?: AppExtension[]; nestedApprovalTimeoutMs?: number } = {},
) {
  const { faux, models, model } = fauxModels();
  const deleted: string[] = [];
  const registry = createRegistry();
  const installed = appOf(agent, app);
  const extensions = agentExtensions(new Map([[agent.kind, agent]]), {
    scope: { kind: agent.kind, name: "a" },
    ports: () => ({ deleted }),
    portsFailed: () => undefined,
    app: () => installed,
    nestedApprovalTimeoutMs,
  });
  for (const extension of [...more, ...app.map(({ extension }) => extension)]) registry.install(extension);
  for (const extension of extensions.values()) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  harnesses.push(harness);
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model },
      async init(tx, id) {
        if (rule === undefined) return;
        (await tx.doc(SessionsDoc)).sessions[String(id)] = {
          createdAt: 1,
          requiresApproval: rule as string[] | { add?: string[]; remove?: string[] },
        };
      },
    },
    context,
  );
  let read: unknown;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(call.name, { key: "a" }, { id: call.id }), { stopReason: "toolUse" }),
    (request) => {
      read = request.messages.at(-1);
      return fauxAssistantMessage("Done.");
    },
  ]);
  const submission = await conversation.submit({ type: "input", content: "Go", requestId: "1" }, context);
  return {
    harness,
    id: conversation.id,
    deleted,
    /** The call's result as the model read it, once the run is done. */
    async result() {
      expect(await submission.wait(context)).toMatchObject({ status: "done" });
      return read;
    },
  };
}

/** Resolves once call `callId` of conversation `id` has reached `status`. */
async function slot(harness: Harness, id: ConversationId, callId: string, status: ToolSlot["status"]): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const live = await harness.snapshot(LiveDoc, id, context);
    if (live?.tools?.some((candidate) => candidate.callId === callId && candidate.status === status)) return;
    if (Date.now() > deadline) throw new Error(`Call ${callId} never became ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Resolves with the nested call of `parentCallId` in conversation `id` once it has reached `status`. */
async function nestedSlot(
  harness: Harness,
  id: ConversationId,
  parentCallId: string,
  status: NestedToolSlot["status"],
): Promise<NestedToolSlot> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const live = await harness.snapshot(LiveDoc, id, context);
    const found = live?.nestedTools?.find((nested) => nested.parentCallId === parentCallId && nested.status === status);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`No nested call of ${parentCallId} became ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const declined = (text: string) => ({ role: "toolResult", isError: true, content: [{ type: "text", text }] });

/** Decides one call as `approve()` does with a batch of one. */
async function decideOne(
  agent: AgentDefinition<Ports>,
  harness: Harness,
  id: ConversationId,
  decision: ApprovalDecision,
  rule?: ApprovalRule,
) {
  const [outcome] = await decide(harness, id, (name) => gatedIn(agent, name, rule), [decision]);
  return outcome;
}

describe("the approval gate", () => {
  it("gates what the agent's policy says of a tool's tier and name, and always a tool of unknown tier", async () => {
    expect(gatedIn(notes, "remove")).toBe(true);
    expect(gatedIn(notes, "lookup")).toBe(false);
    const byName = notesUnder((tier, name) => tier === "read" && name === "lookup");
    expect([gatedIn(byName, "lookup"), gatedIn(byName, "remove")]).toEqual([true, false]);

    // Even a policy that gates nothing parks a tool the runtime knows no tier of.
    const lax = notesUnder(() => false);
    expect(gatedIn(lax, "clock")).toBe(true);
    const { harness, id, result } = await conversationOf(lax, { name: "clock", id: "c-1" }, { more: [clock] });
    await slot(harness, id, "c-1", "sleeping");
    expect(await decideOne(lax, harness, id, { toolCallId: "c-1", approved: true })).toEqual({
      toolCallId: "c-1",
      outcome: "applied",
    });
    expect(await result()).toMatchObject({
      role: "toolResult",
      isError: false,
      content: [{ type: "text", text: "noon" }],
    });
    expect(await decisionsOf(harness, id)).toEqual({
      "c-1": { approved: true, args: { key: "a" }, at: expect.any(Number) },
    });
  });

  it("parks a gated call until it is approved, then runs it and records the decision", async () => {
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" });
    await slot(harness, id, "rm-1", "sleeping");
    expect(deleted).toEqual([]);
    expect(await decisionsOf(harness, id)).toEqual({});

    expect(await decideOne(notes, harness, id, { toolCallId: "rm-1", approved: true })).toEqual({
      toolCallId: "rm-1",
      outcome: "applied",
    });
    expect(await result()).toMatchObject({
      role: "toolResult",
      isError: false,
      content: [{ type: "text", text: "deleted a" }],
    });
    expect(deleted).toEqual(["a"]);
    expect(await decisionsOf(harness, id)).toEqual({
      "rm-1": { approved: true, args: { key: "a" }, at: expect.any(Number) },
    });
    // The call left the gate: a second decision finds nothing waiting.
    await expect(decideOne(notes, harness, id, { toolCallId: "rm-1", approved: false })).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
  });

  it.each([
    { comment: "Keep the apples.", text: "The operator declined this call: Keep the apples." },
    { comment: undefined, text: "The operator declined this call." },
  ])("declined with comment $comment, hands the model its refusal as the call's result", async ({ comment, text }) => {
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" });
    await slot(harness, id, "rm-1", "sleeping");
    const decision = { toolCallId: "rm-1", approved: false, ...(comment !== undefined && { comment }) };
    expect(await decideOne(notes, harness, id, decision)).toEqual({ toolCallId: "rm-1", outcome: "applied" });
    expect(await result()).toMatchObject(declined(text));
    expect(deleted).toEqual([]);
    expect(await decisionsOf(harness, id)).toEqual({
      "rm-1": {
        approved: false,
        ...(comment !== undefined && { comment }),
        args: { key: "a" },
        at: expect.any(Number),
      },
    });
  });

  it("takes the first of two decisions for one call, and records only that one", async () => {
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" });
    await slot(harness, id, "rm-1", "sleeping");
    const outcomes = await Promise.all([
      decideOne(notes, harness, id, { toolCallId: "rm-1", approved: true }),
      decideOne(notes, harness, id, { toolCallId: "rm-1", approved: false, comment: "no" }),
    ]);
    expect(outcomes).toEqual([
      { toolCallId: "rm-1", outcome: "applied" },
      { toolCallId: "rm-1", outcome: "already_decided" },
    ]);
    expect(await result()).toMatchObject({ isError: false, content: [{ type: "text", text: "deleted a" }] });
    expect(deleted).toEqual(["a"]);
    expect(await decisionsOf(harness, id)).toEqual({
      "rm-1": { approved: true, args: { key: "a" }, at: expect.any(Number) },
    });
  });

  it("refuses a call that is not waiting at the gate, and commits nothing", async () => {
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" });
    await expect(decideOne(notes, harness, id, { toolCallId: "ghost", approved: true })).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
    await slot(harness, id, "rm-1", "sleeping");
    expect(await decisionsOf(harness, id)).toEqual({});
    expect(deleted).toEqual([]);
    // Still waiting: the refusal delivered nothing.
    expect(await decideOne(notes, harness, id, { toolCallId: "rm-1", approved: true })).toEqual({
      toolCallId: "rm-1",
      outcome: "applied",
    });
    expect(await result()).toMatchObject({ isError: false, content: [{ type: "text", text: "deleted a" }] });
  });

  it("applies a batch whole or not at all: one call not waiting refuses every decision of it", async () => {
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" });
    await slot(harness, id, "rm-1", "sleeping");
    const gated = (name: string) => gatedIn(notes, name);
    const error = await decide(harness, id, gated, [
      { toolCallId: "rm-1", approved: true },
      { toolCallId: "ghost", approved: true },
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApprovalNotPendingError);
    expect((error as ApprovalNotPendingError).toolCallId).toBe("ghost");
    expect(await decisionsOf(harness, id)).toEqual({});
    expect(deleted).toEqual([]);
    await expect(
      decide(harness, id, gated, [
        { toolCallId: "rm-1", approved: true },
        { toolCallId: "rm-1", approved: false },
      ]),
    ).rejects.toBeInstanceOf(TypeError);

    expect(await decide(harness, id, gated, [{ toolCallId: "rm-1", approved: true }])).toEqual([
      { toolCallId: "rm-1", outcome: "applied" },
    ]);
    expect(await result()).toMatchObject({ isError: false, content: [{ type: "text", text: "deleted a" }] });
  });
});

describe("the arguments a decision is made on", () => {
  it("are those the gate saw when the call parked, after every hook before it, and the call runs with them", async () => {
    const more = [rewriting(() => ({ key: "b" }))];
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" }, { more });
    await slot(harness, id, "rm-1", "sleeping");
    expect(await decideOne(notes, harness, id, { toolCallId: "rm-1", approved: true })).toEqual({
      toolCallId: "rm-1",
      outcome: "applied",
    });
    expect(await result()).toMatchObject({ isError: false, content: [{ type: "text", text: "deleted b" }] });
    expect(deleted).toEqual(["b"]);
    expect(await decisionsOf(harness, id)).toEqual({
      "rm-1": { approved: true, args: { key: "b" }, at: expect.any(Number) },
    });
  });

  it("run an approved call, however a hook rewrites it after it parked", async () => {
    const more = [rewriting((pass) => ({ key: `b${pass}` }))];
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" }, { more });
    await slot(harness, id, "rm-1", "sleeping");
    await decideOne(notes, harness, id, { toolCallId: "rm-1", approved: true });
    // The decision ran the chain again, and the hook rewrote the call to `b2`: it runs with what the operator saw.
    expect(await result()).toMatchObject({
      role: "toolResult",
      isError: false,
      content: [{ type: "text", text: "deleted b1" }],
    });
    expect(deleted).toEqual(["b1"]);
    expect(await decisionsOf(harness, id)).toEqual({
      "rm-1": { approved: true, args: { key: "b1" }, at: expect.any(Number) },
    });
  });

  it("run an approved call whose arguments come back in another key order", async () => {
    const more = [rewriting((pass) => (pass === 1 ? { key: "b", note: "n" } : { note: "n", key: "b" }))];
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" }, { more });
    await slot(harness, id, "rm-1", "sleeping");
    await decideOne(notes, harness, id, { toolCallId: "rm-1", approved: true });
    expect(await result()).toMatchObject({ isError: false, content: [{ type: "text", text: "deleted b" }] });
    expect(deleted).toEqual(["b"]);
  });
});

describe("a session's own approval rule", () => {
  it("replaces the agent's policy with exactly its tiers, or adds and removes tiers of it", () => {
    expect([gatedIn(notes, "remove", []), gatedIn(notes, "lookup", [])]).toEqual([false, false]);
    expect([gatedIn(notes, "remove", ["read"]), gatedIn(notes, "lookup", ["read"])]).toEqual([false, true]);
    expect(gatedIn(notes, "lookup", { add: ["read"] })).toBe(true);
    expect(gatedIn(notes, "remove", { remove: ["write"] })).toBe(false);
    expect(gatedIn(notes, "remove", { add: ["read"] })).toBe(true);
    // No rule lets a tool of unknown tier run without a decision.
    expect([gatedIn(notes, "clock", []), gatedIn(notes, "clock", { remove: ["read", "write"] })]).toEqual([true, true]);
  });

  it("parks a call the session's rule gates, which the agent's policy alone would run", async () => {
    const { harness, id, result } = await conversationOf(notes, { name: "lookup", id: "lk-1" }, { rule: ["read"] });
    await slot(harness, id, "lk-1", "sleeping");
    expect(await decideOne(notes, harness, id, { toolCallId: "lk-1", approved: false }, ["read"])).toEqual({
      toolCallId: "lk-1",
      outcome: "applied",
    });
    expect(await result()).toMatchObject(declined("The operator declined this call."));
  });

  it("runs a call the session's rule no longer gates without a decision", async () => {
    const { deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" }, { rule: [] });
    expect(await result()).toMatchObject({ isError: false, content: [{ type: "text", text: "deleted a" }] });
    expect(deleted).toEqual(["a"]);
  });

  it("decides a call that parked, whatever the session's rule says by then", async () => {
    const { harness, id, deleted, result } = await conversationOf(notes, { name: "remove", id: "rm-1" });
    await slot(harness, id, "rm-1", "sleeping");
    // The rule changed while the call waited: the decision still finds it, and a decline still stops it.
    expect(await decideOne(notes, harness, id, { toolCallId: "rm-1", approved: false }, [])).toEqual({
      toolCallId: "rm-1",
      outcome: "applied",
    });
    expect(await result()).toMatchObject(declined("The operator declined this call."));
    expect(deleted).toEqual([]);
  });
});

describe("a nested call", () => {
  it("parks until it is approved, then runs, its caller carries on, and the decision is recorded", async () => {
    const { harness, id, deleted, result } = await conversationOf(
      notes,
      { name: "script", id: "sc-1" },
      {
        app: [scripting],
      },
    );
    const nested = await nestedSlot(harness, id, "sc-1", "sleeping");
    expect(nested).toMatchObject({ callId: "sc-1/1", name: "remove", arguments: { key: "a" } });
    expect(deleted).toEqual([]);

    expect(await decideOne(notes, harness, id, { toolCallId: "sc-1/1", approved: true })).toEqual({
      toolCallId: "sc-1/1",
      outcome: "applied",
    });
    expect(await result()).toMatchObject({
      role: "toolResult",
      isError: false,
      content: [{ type: "text", text: "deleted a" }],
    });
    expect(deleted).toEqual(["a"]);
    expect(await decisionsOf(harness, id)).toEqual({
      "sc-1/1": { approved: true, args: { key: "a" }, at: expect.any(Number) },
    });
    // The caller is not at the gate: it runs, waiting on its nested call.
    await expect(decideOne(notes, harness, id, { toolCallId: "sc-1", approved: true })).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
  });

  it("declined, hands its caller the operator's refusal as its result, and does not run", async () => {
    const { harness, id, deleted, result } = await conversationOf(
      notes,
      { name: "script", id: "sc-1" },
      {
        app: [scripting],
      },
    );
    await nestedSlot(harness, id, "sc-1", "sleeping");
    const decision = { toolCallId: "sc-1/1", approved: false, comment: "Keep a." };
    expect(await decideOne(notes, harness, id, decision)).toEqual({ toolCallId: "sc-1/1", outcome: "applied" });
    expect(await result()).toMatchObject({
      role: "toolResult",
      isError: true,
      content: [{ type: "text", text: "The operator declined this call: Keep a." }],
    });
    expect(deleted).toEqual([]);
    expect(await decisionsOf(harness, id)).toEqual({
      "sc-1/1": { approved: false, comment: "Keep a.", args: { key: "a" }, at: expect.any(Number) },
    });
  });

  it("with no decision by its deadline, fails for its caller, and cannot be decided then", async () => {
    const { harness, id, deleted, result } = await conversationOf(
      notes,
      { name: "script", id: "sc-1" },
      { app: [scripting], nestedApprovalTimeoutMs: 50 },
    );
    // The caller reads the gate's words, as an error diagnostic of its nested call's.
    expect(await result()).toMatchObject({
      role: "toolResult",
      isError: true,
      content: [{ type: "text", text: "No decision arrived in time." }],
    });
    expect(deleted).toEqual([]);
    expect(await decisionsOf(harness, id)).toEqual({});
    await expect(decideOne(notes, harness, id, { toolCallId: "sc-1/1", approved: true })).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
  });

  it("has a deadline a call of the model's does not: that one waits on", async () => {
    const { harness, id, deleted, result } = await conversationOf(
      notes,
      { name: "remove", id: "rm-1" },
      { nestedApprovalTimeoutMs: 20 },
    );
    await slot(harness, id, "rm-1", "sleeping");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await slot(harness, id, "rm-1", "sleeping");
    expect(await decideOne(notes, harness, id, { toolCallId: "rm-1", approved: true })).toEqual({
      toolCallId: "rm-1",
      outcome: "applied",
    });
    expect(await result()).toMatchObject({ isError: false, content: [{ type: "text", text: "deleted a" }] });
    expect(deleted).toEqual(["a"]);
  });
});
