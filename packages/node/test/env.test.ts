// An instance's execution environment on a real shell: `envFor` gives the scope pi-durable's Node environment, and
// an app extension's `bash` runs in its working directory, as the core README's "The runtime" says.

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createAgentRuntime, defineAgent } from "@chia1104/motoko-core";
import type { AgentRuntime, AgentSession } from "@chia1104/motoko-core";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

import { nodeHost, sqliteStorage } from "../src/index.ts";

// Its policy gates no tier, so the `exec` call runs without asking.
const agent = defineAgent({ kind: "coder", instructions: "You code.", tools: [] });
const shell = defineExtension({ name: "shell", tools: [createBashTool()] });

let directory: string;
let workspace: string;
let runtime: AgentRuntime | undefined;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.provider.id, modelId: faux.getModel().id };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-runtime-env-"));
  // macOS's temp directory is a link into `/private`, which `pwd` prints resolved.
  workspace = await realpath(await mkdtemp(join(tmpdir(), "agent-runtime-workspace-")));
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await rm(directory, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

async function readUntil(session: AgentSession, until: (event: AgentWireEvent) => boolean): Promise<StreamItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const items: StreamItem[] = [];
  try {
    for await (const item of session.events({ signal: controller.signal })) {
      items.push(item);
      if (until(item.event)) return items;
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`No matching event; read ${items.map((item) => item.event.type).join(", ")}`);
}

describe("an instance's execution environment", () => {
  it("runs the app's bash in the working directory `envFor` gives the scope", async () => {
    const alice = join(workspace, "alice");
    await mkdir(alice);
    runtime = createAgentRuntime({
      agents: [agent],
      host: nodeHost({ storage: sqliteStorage({ directory }) }),
      models,
      ports: {},
      defaultModel: model,
      envFor: (scope) => () => new NodeExecutionEnv({ cwd: join(workspace, scope.name) }),
      extensionsFor: () => [{ extension: shell, tier: () => "exec" }],
    });
    let read: unknown;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }, { id: "b-1" }), { stopReason: "toolUse" }),
      (request) => {
        read = request.messages.at(-1);
        return fauxAssistantMessage("Done.");
      },
    ]);
    const instance = runtime.get(agent, "alice");
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Where are you?", requestId: "1" });

    const items = await readUntil(session, (event) => event.type === "run:end");
    expect(items.find((item) => item.event.type === "tool:end")?.event).toEqual({
      type: "tool:end",
      toolCallId: "b-1",
      toolName: "bash",
      status: "ok",
    });
    // A call that succeeds shows no output at its end: its result is what the model read.
    expect(read).toMatchObject({
      role: "toolResult",
      toolCallId: "b-1",
      isError: false,
      content: [{ type: "text", text: `${alice}\n` }],
    });
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
  });
});
