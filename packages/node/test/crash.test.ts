import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createAgentRuntime } from "@chia1104/motoko-core";
import type { AgentRuntime, AgentSession } from "@chia1104/motoko-core";
import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

import { nodeHost, sqliteStorage } from "../src/index.ts";

import { crashAgent, crashState } from "./fixtures/crash-agent.ts";
import type { CrashPorts } from "./fixtures/crash-agent.ts";
import { eventually, fold, follow, has, runEnds, settle } from "./helpers.ts";

const CHILD = fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url));

/**
 * Runs the child until it reports READY, then kills it with SIGKILL: no close, no cleanup. Returns
 * the session and what the child's client had read, the last item's cursor being where it was cut.
 */
async function crashAfterReady(
  directory: string,
  scenario: "tool" | "approval",
): Promise<{ sessionId: string; items: StreamItem[] }> {
  const child = spawn(process.execPath, ["--conditions=@chia1104/motoko-source", CHILD, directory, scenario], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<{ sessionId: string; items: StreamItem[] }>((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`child never got ready: ${stderr}`)), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const items = /^ITEMS (.*)$/m.exec(stdout);
      const match = /^READY (\d+)$/m.exec(stdout);
      if (match && items) {
        clearTimeout(timer);
        resolve({ sessionId: match[1]!, items: JSON.parse(items[1]!) as StreamItem[] });
      }
    });
    child.on("exit", (code) => reject(new Error(`child exited ${code}: ${stderr}`)));
  });
  const result = await ready;
  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  return result;
}

let directory: string;
let runtime: AgentRuntime | undefined;
const ports: CrashPorts = { log: [] };
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-runtime-crash-"));
  ports.log.length = 0;
  crashState.finish = false;
  delete crashState.release;
  crashState.started = () => undefined;
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await rm(directory, { recursive: true, force: true });
});

function reopen() {
  runtime = createAgentRuntime({
    agents: [crashAgent],
    host: nodeHost({ storage: sqliteStorage({ directory }) }),
    models,
    ports,
    defaultModel: { provider: faux.provider.id, modelId: faux.getModel().id },
  });
  return runtime.get(crashAgent, "c1");
}

const readUntil = (session: AgentSession, until: (event: AgentWireEvent) => boolean) =>
  readFrom(session, undefined, until);

async function readFrom(
  session: AgentSession,
  from: string | undefined,
  until: (event: AgentWireEvent) => boolean,
): Promise<StreamItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
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

describe("recovery after the process is killed", () => {
  it("reruns a replay-safe call the killed process was running, and completes the run", async () => {
    const { sessionId } = await crashAfterReady(directory, "tool");
    crashState.finish = true;
    let sawResult: unknown;
    faux.setResponses([
      (request) => {
        sawResult = request.messages.at(-1);
        return fauxAssistantMessage("Indexed.");
      },
    ]);
    const session = reopen().session(sessionId);
    const items = await readUntil(session, (event) => event.type === "run:end");

    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    expect(ports.log).toEqual(["indexed /srv"]);
    expect(sawResult).toMatchObject({ role: "toolResult", toolCallId: "idx-1", isError: false });
    expect(foldEvents(items.map((item) => item.event)).items).toMatchObject([
      { kind: "user", text: "Index /srv" },
      { kind: "assistant", stopReason: "toolUse" },
      { kind: "tool", toolCallId: "idx-1", status: "ok" },
      { kind: "assistant", text: "Indexed." },
    ]);
  }, 30_000);

  it("keeps an approval the killed process was waiting for decidable", async () => {
    const { sessionId } = await crashAfterReady(directory, "approval");
    faux.setResponses([fauxAssistantMessage("Published.")]);
    const session = reopen().session(sessionId);
    const asked = await readUntil(session, (event) => event.type === "approval:request");
    expect(foldEvents(asked.map((item) => item.event)).pendingApprovals).toEqual(["pub-1"]);
    expect(ports.log).toEqual([]);

    await session.approve([{ toolCallId: "pub-1", approved: true }]);
    const items = await readUntil(session, (event) => event.type === "run:end");
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    expect(ports.log).toEqual(["published launch"]);
  }, 30_000);
});

describe("a cursor from the killed process", () => {
  // The killed process's client was cut at its last item; it reconnects to a fresh runtime on the same
  // SQLite file. A client connected to the fresh runtime from its start is the reference.

  it("resumes while the rerun call is running, without a full replay, into the same view", async () => {
    const { sessionId, items: before } = await crashAfterReady(directory, "tool");
    let release: () => void = () => undefined;
    crashState.release = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      crashState.started = resolve;
    });
    faux.setResponses([fauxAssistantMessage("Indexed.")]);
    const session = reopen().session(sessionId);
    const reference = follow(session);
    await started;
    const back = follow(session, before.at(-1)!.cursor);
    await eventually(() => back.items.length > 0 && has(reference.items, "tool:start"));
    await settle();

    expect(has(back.items, "stream:reset") || has(back.items, "user") || has(back.items, "tool:start")).toBe(false);
    const view = fold(before, back.items);
    expect(view).toEqual(fold(reference.items));
    expect(view.items.find((item) => item.kind === "tool")).toMatchObject({ toolCallId: "idx-1", status: "running" });

    release();
    await eventually(() => runEnds(reference.items) === 1 && runEnds(back.items) === 1);
    await Promise.all([reference.stop(), back.stop()]);
    expect(fold(before, back.items)).toEqual(fold(reference.items));
    expect(ports.log).toEqual(["indexed /srv"]);
  }, 30_000);

  it("resumes while the approval is pending, asking again", async () => {
    const { sessionId, items: before } = await crashAfterReady(directory, "approval");
    faux.setResponses([fauxAssistantMessage("Published.")]);
    const session = reopen().session(sessionId);
    const reference = follow(session);
    const back = follow(session, before.at(-1)!.cursor);
    await eventually(() => has(back.items, "approval:request") && has(reference.items, "approval:request"));
    await settle();
    expect(has(back.items, "stream:reset") || has(back.items, "user")).toBe(false);
    expect(fold(before, back.items)).toEqual(fold(reference.items));
    expect(fold(before, back.items).pendingApprovals).toEqual(["pub-1"]);

    await session.approve([{ toolCallId: "pub-1", approved: true }]);
    await eventually(() => runEnds(reference.items) === 1 && runEnds(back.items) === 1);
    await Promise.all([reference.stop(), back.stop()]);
    expect(fold(before, back.items)).toEqual(fold(reference.items));
    expect(ports.log).toEqual(["published launch"]);
  }, 30_000);

  it("resumes after the approval was decided while it was away", async () => {
    const { sessionId, items: before } = await crashAfterReady(directory, "approval");
    faux.setResponses([fauxAssistantMessage("Not published.")]);
    const session = reopen().session(sessionId);
    const reference = follow(session);
    await eventually(() => has(reference.items, "approval:request"));
    await session.approve([{ toolCallId: "pub-1", approved: false, comment: "Not today." }]);
    await eventually(() => runEnds(reference.items) === 1);

    const back = await readFrom(session, before.at(-1)!.cursor, (event) => event.type === "run:end");
    await reference.stop();
    expect(has(back, "stream:reset") || has(back, "user")).toBe(false);
    expect(back.find((item) => item.event.type === "approval:resolved")?.event).toEqual({
      type: "approval:resolved",
      toolCallId: "pub-1",
      approved: false,
      comment: "Not today.",
    });
    const view = fold(before, back);
    expect(view).toEqual(fold(reference.items));
    expect(view.items.find((item) => item.kind === "tool")).toMatchObject({
      status: "error",
      approval: { approved: false, comment: "Not today." },
    });
    expect(ports.log).toEqual([]);
  }, 30_000);
});
