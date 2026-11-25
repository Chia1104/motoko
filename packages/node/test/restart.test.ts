import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "@chia1104/motoko-core";
import type { AgentRuntime, AgentSession, ToolContext } from "@chia1104/motoko-core";
import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

import { nodeHost, scopeFile, sqliteStorage } from "../src/index.ts";

interface Ports {
  readonly log: string[];
}

function blockingTool(name: string, replay: "safe" | "unsafe") {
  const state = { runs: 0, released: false, started: (): void => undefined };
  const tool = defineTool({
    name,
    description: "Does slow work",
    tier: "read",
    replay,
    parameters: z.object({ job: z.string() }),
    async execute({ job }, { ports, signal }: ToolContext<Ports>) {
      state.runs += 1;
      state.started();
      if (!state.released) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("stopped by the host");
      }
      ports.log.push(`${name}:${job}`);
      return { text: `${job} finished` };
    },
  });
  return { tool, state };
}

const slowSafe = blockingTool("slow_safe", "safe");
const slowUnsafe = blockingTool("slow_unsafe", "unsafe");

const send = defineTool({
  name: "send",
  description: "Send a message",
  tier: "external",
  parameters: z.object({ to: z.string() }),
  async execute({ to }, { ports }: ToolContext<Ports>) {
    ports.log.push(`sent:${to}`);
    return { text: `sent to ${to}` };
  },
});

const agent = defineAgent<Ports>({
  kind: "worker",
  instructions: "You work.",
  tools: [slowSafe.tool, slowUnsafe.tool, send],
  policy: { requiresApproval: ["external"] },
});

let directory: string;
const runtimes: AgentRuntime[] = [];
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.provider.id, modelId: faux.getModel().id };
const ports: Ports = { log: [] };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-runtime-restart-"));
  ports.log.length = 0;
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await rm(directory, { recursive: true, force: true });
});

function openRuntime() {
  const runtime = createAgentRuntime({
    agents: [agent],
    host: nodeHost({ storage: sqliteStorage({ directory }) }),
    models,
    ports,
    defaultModel: model,
  });
  runtimes.push(runtime);
  return runtime.get(agent, "w1");
}

async function readUntil(
  session: AgentSession,
  until: (event: AgentWireEvent) => boolean,
  from?: string,
): Promise<StreamItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const items: StreamItem[] = [];
  try {
    for await (const item of session.events({ ...(from !== undefined && { from }), signal: controller.signal })) {
      items.push(item);
      if (until(item.event)) return items;
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`No matching event; read ${items.map((item) => item.event.type).join(", ")}`);
}

const isRunEnd = (event: AgentWireEvent) => event.type === "run:end";
const lastResult = { value: undefined as unknown };
const finalAnswer = (text: string) => (request: { messages: readonly unknown[] }) => {
  lastResult.value = request.messages.at(-1);
  return fauxAssistantMessage(text);
};

describe("restart recovery on a real SQLite file", () => {
  it("keeps the scope in its own file", async () => {
    const instance = openRuntime();
    await instance.createSession();
    expect(scopeFile(directory, { kind: "worker", name: "w1" })).toBe(join(directory, "worker", "w1.sqlite"));
  });

  it("carries on a replay-safe call the previous process was running", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("slow_safe", { job: "report" }, { id: "s-1" }), { stopReason: "toolUse" }),
      finalAnswer("The report is ready."),
    ]);
    const first = openRuntime();
    const { id } = await first.createSession();
    const started = new Promise<void>((resolve) => {
      slowSafe.state.started = resolve;
    });
    await first.session(id).submit({ text: "Make the report", requestId: "r1" });
    await started;
    const before = await readUntil(first.session(id), (event) => event.type === "tool:start");
    await runtimes.shift()!.close();

    slowSafe.state.released = true;
    const second = openRuntime();
    const session = second.session(id);
    const items = await readUntil(session, isRunEnd);

    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    expect(ports.log).toEqual(["slow_safe:report"]);
    expect(slowSafe.state.runs).toBe(2);
    expect(JSON.stringify(lastResult.value)).toContain("report finished");
    const resumed = await readUntil(session, isRunEnd, before.at(-1)!.cursor);
    expect(resumed.some((item) => item.event.type === "stream:reset" || item.event.type === "user")).toBe(false);
    expect(foldEvents([...before, ...resumed].map((item) => item.event))).toEqual(
      foldEvents(items.map((item) => item.event)),
    );
    const view = foldEvents(items.map((item) => item.event));
    expect(view.items).toMatchObject([
      { kind: "user", text: "Make the report" },
      { kind: "assistant", stopReason: "toolUse" },
      { kind: "tool", toolCallId: "s-1", status: "ok" },
      { kind: "assistant", text: "The report is ready." },
    ]);
  });

  it("tells the model a replay-unsafe call was interrupted", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("slow_unsafe", { job: "charge" }, { id: "u-1" }), { stopReason: "toolUse" }),
      finalAnswer("The charge was interrupted."),
    ]);
    const first = openRuntime();
    const { id } = await first.createSession();
    const started = new Promise<void>((resolve) => {
      slowUnsafe.state.started = resolve;
    });
    await first.session(id).submit({ text: "Charge", requestId: "r1" });
    await started;
    await runtimes.shift()!.close();

    slowUnsafe.state.released = true;
    const second = openRuntime();
    const items = await readUntil(second.session(id), isRunEnd);
    expect(slowUnsafe.state.runs).toBe(1);
    expect(ports.log).toEqual([]);
    expect(items.find((item) => item.event.type === "tool:end")?.event).toMatchObject({
      toolCallId: "u-1",
      status: "aborted",
    });
    expect(lastResult.value).toMatchObject({ role: "toolResult", isError: true });
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
  });

  it("keeps a pending approval decidable across a restart, and replays it after", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("send", { to: "ops" }, { id: "send-1" }), { stopReason: "toolUse" }),
      finalAnswer("Sent."),
    ]);
    const first = openRuntime();
    const { id } = await first.createSession();
    await first.session(id).submit({ text: "Tell ops", requestId: "r1" });
    const asked = await readUntil(first.session(id), (event) => event.type === "approval:request");
    const liveBefore = foldEvents(asked.map((item) => item.event));
    expect(liveBefore.pendingApprovals).toEqual(["send-1"]);
    await runtimes.shift()!.close();

    const second = openRuntime();
    const session = second.session(id);
    const replayed = await readUntil(session, (event) => event.type === "approval:request");
    expect(foldEvents(replayed.map((item) => item.event))).toEqual(liveBefore);
    expect(ports.log).toEqual([]);

    expect(await session.approve([{ toolCallId: "send-1", approved: true }])).toEqual([
      { toolCallId: "send-1", outcome: "applied" },
    ]);
    const done = await readUntil(session, isRunEnd);
    expect(ports.log).toEqual(["sent:ops"]);
    expect(JSON.stringify(lastResult.value)).toContain("sent to ops");
    const live = foldEvents(done.map((item) => item.event));
    expect(live.items.find((item) => item.kind === "tool")).toMatchObject({
      status: "ok",
      approval: { approved: true },
    });

    await runtimes.shift()!.close();
    const third = openRuntime();
    const final = await readUntil(third.session(id), isRunEnd);
    expect(foldEvents(final.map((item) => item.event))).toEqual(live);
    expect(await third.listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
  });

  it("keeps a decision made just before a restart", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("send", { to: "sales" }, { id: "send-2" }), { stopReason: "toolUse" }),
      finalAnswer("Not sent."),
    ]);
    const first = openRuntime();
    const { id } = await first.createSession();
    await first.session(id).submit({ text: "Tell sales", requestId: "r1" });
    await readUntil(first.session(id), (event) => event.type === "approval:request");
    await first.session(id).approve([{ toolCallId: "send-2", approved: false, comment: "Not yet." }]);
    await runtimes.shift()!.close();

    const second = openRuntime();
    const items = await readUntil(second.session(id), isRunEnd);
    expect(ports.log).toEqual([]);
    expect(lastResult.value).toMatchObject({
      role: "toolResult",
      isError: true,
      content: [{ type: "text", text: "The operator declined this call: Not yet." }],
    });
    expect(foldEvents(items.map((item) => item.event)).items.find((item) => item.kind === "tool")).toMatchObject({
      status: "error",
      approval: { approved: false, comment: "Not yet." },
    });
  });
});
