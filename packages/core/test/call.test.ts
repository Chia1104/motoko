// The call protocol run on an instance through `runCall`, as a transport does: each call parsed with wire's schemas,
// its result checked against its result schema, and each failure read with `callErrorOf`.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { callSchemas } from "@chia1104/motoko-wire";
import type { Call, CallMethod, CallParams, CallResult } from "@chia1104/motoko-wire";

import {
  ApprovalNotPendingError,
  callErrorOf,
  createAgentRuntime,
  defineAgent,
  defineTool,
  InstanceClosedError,
  InvalidCursorError,
  LeaseHeldError,
  runCall,
  SessionBusyError,
  SessionNotFoundError,
  SessionOwnedError,
} from "../src/index.ts";
import type { AgentInstance, AgentRuntime, ToolContext } from "../src/index.ts";

import { fauxModels, isRunEnd, memoryHost, readUntil } from "./helpers.ts";

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
  tools: [remove, wait],
  policy: { requiresApproval: ["write"] },
});

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

function setup() {
  const { faux, models, model } = fauxModels();
  const ports: Ports = { deleted: [] };
  runtime = createAgentRuntime({ agents: [notesAgent], host: memoryHost(), models, ports, defaultModel: model });
  return { faux, ports, instance: runtime.get(notesAgent, "alice") };
}

/** Runs `method` with `params` as a transport does: params parsed, the result checked against its schema. */
async function call<M extends CallMethod>(
  instance: AgentInstance,
  method: M,
  params: CallParams<M>,
): Promise<CallResult<M>> {
  // SAFETY: the params are `method`'s, parsed with its own schema.
  const parsed = { method, params: callSchemas[method].params.parse(params) } as Call & { method: M };
  const result = await runCall(instance, parsed);
  // SAFETY: parsed with `method`'s result schema.
  return callSchemas[method].result.parse(result) as CallResult<M>;
}

/** What a call that rejects answers. */
async function failure(pending: Promise<unknown>) {
  const error = await pending.then(
    () => expect.unreachable("the call succeeded"),
    (error: unknown) => error,
  );
  return callErrorOf(error);
}

describe("runCall", () => {
  it("createSession makes a session that listSessions lists, oldest first", async () => {
    const { instance } = setup();
    const first = await call(instance, "createSession", {});
    const second = await call(instance, "createSession", {});
    expect(first).toEqual({ id: expect.any(String), createdAt: expect.any(Number) });
    expect(await call(instance, "listSessions", {})).toEqual([first, second]);
  });

  it("submit admits the input once per requestId and runs it", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage("Hello there.")]);
    const { id } = await call(instance, "createSession", {});
    const submitted = await call(instance, "submit", { sessionId: id, text: "Hi", requestId: "m1" });
    expect(submitted).toEqual({ submissionId: expect.any(String) });
    expect(await call(instance, "submit", { sessionId: id, text: "Hi", requestId: "m1" })).toEqual(submitted);
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(items.map((item) => item.event)).toContainEqual({ type: "run:end", reason: "done" });
  });

  it("approve decides a call waiting for approval, which then runs", async () => {
    const { faux, ports, instance } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Deleted."),
    ]);
    const { id } = await call(instance, "createSession", {});
    await call(instance, "submit", { sessionId: id, text: "Delete a", requestId: "d1" });
    await readUntil(instance.session(id), (event) => event.type === "approval:request");
    const decisions = [{ toolCallId: "rm-1", approved: true }];
    expect(await call(instance, "approve", { sessionId: id, decisions })).toEqual([
      { toolCallId: "rm-1", outcome: "applied" },
    ]);
    await readUntil(instance.session(id), isRunEnd);
    expect(ports.deleted).toEqual(["a"]);
  });

  it("abort ends the run as aborted", async () => {
    const { faux, instance } = setup();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}, { id: "w-1" }), { stopReason: "toolUse" })]);
    const started = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const { id } = await call(instance, "createSession", {});
    await call(instance, "submit", { sessionId: id, text: "Wait", requestId: "w" });
    await started;
    expect(await call(instance, "abort", { sessionId: id })).toBeNull();
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(items.at(-1)?.event).toMatchObject({ type: "run:end", reason: "aborted" });
  });

  it("deleteSession removes the session", async () => {
    const { instance } = setup();
    const { id } = await call(instance, "createSession", {});
    expect(await call(instance, "deleteSession", { sessionId: id })).toBeNull();
    expect(await call(instance, "listSessions", {})).toEqual([]);
  });
});

describe("callErrorOf", () => {
  it("answers the runtime's errors from a call with their codes", async () => {
    const { faux, instance } = setup();
    expect(await failure(call(instance, "abort", { sessionId: "nope" }))).toMatchObject({ code: "session_not_found" });

    faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}, { id: "w-1" }), { stopReason: "toolUse" })]);
    const started = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const { id } = await call(instance, "createSession", {});
    await call(instance, "submit", { sessionId: id, text: "Wait", requestId: "w" });
    await started;
    const busy = call(instance, "submit", { sessionId: id, text: "Again", requestId: "w2", whenBusy: "reject" });
    expect(await failure(busy)).toMatchObject({ code: "session_busy" });
    const decisions = [{ toolCallId: "ghost", approved: true }];
    expect(await failure(call(instance, "approve", { sessionId: id, decisions }))).toMatchObject({
      code: "approval_not_pending",
    });
    await call(instance, "abort", { sessionId: id });
  });

  it("maps each of the runtime's errors to its code, with its message", () => {
    const scope = { kind: "notes", name: "alice" };
    const cases = [
      [new SessionNotFoundError("s"), "session_not_found"],
      [new SessionBusyError("s"), "session_busy"],
      [new SessionOwnedError("s"), "session_owned"],
      [new ApprovalNotPendingError("t"), "approval_not_pending"],
      [new InvalidCursorError("c"), "invalid_cursor"],
      [new InstanceClosedError(scope, "lease_lost"), "instance_closed"],
      [new LeaseHeldError(scope), "lease_held"],
    ] as const;
    for (const [error, code] of cases) expect(callErrorOf(error)).toEqual({ code, message: error.message });
  });

  it("leaves any other error to the transport", () => {
    expect(callErrorOf(new Error("disk on fire"))).toBeUndefined();
    expect(callErrorOf(new TypeError("Tool call t is decided twice"))).toBeUndefined();
    expect(callErrorOf("a string")).toBeUndefined();
  });
});
