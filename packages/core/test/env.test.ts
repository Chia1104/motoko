// An instance's execution environment, on the faux provider: `envFor` resolves it from the scope each time the
// instance opens, and an app tool reads what it built as `api.env`, as the README's "The runtime" says.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool as definePiTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { StreamItem } from "@chia1104/motoko-wire";

import { createAgentRuntime, defineAgent } from "../src/index.ts";
import type { AgentRuntime, StorageScope } from "../src/index.ts";

import { durableMemoryHost, fauxModels, isRunEnd, memoryPlace, readUntil } from "./helpers.ts";

const agent = defineAgent({ kind: "coder", instructions: "You code.", tools: [] });

/** Reports the working directory of the environment its call was given, `null` for none. */
const where = defineExtension({
  name: "where",
  tools: [
    definePiTool({
      name: "where",
      description: "The working directory",
      parameters: { type: "object", properties: {} },
      async execute(_args, api) {
        const cwd = api.env?.cwd ?? null;
        return { output: [{ type: "text", text: String(cwd) }], details: { cwd } };
      },
    }),
  ],
});

// SAFETY: the `where` tool reads nothing of an environment but its `cwd`.
const envAt = (cwd: string) => ({ id: "test", cwd }) as Partial<ExecutionEnv> as ExecutionEnv;

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("execution environment", () => {
  it("resolves `envFor` each time an instance opens, and hands what it builds to the instance's tools", async () => {
    const place = memoryPlace();
    const { faux, models, model } = fauxModels();
    const opens: StorageScope[] = [];
    const start = () => {
      runtime = createAgentRuntime({
        agents: [agent],
        host: durableMemoryHost(place),
        models,
        ports: {},
        defaultModel: model,
        envFor: (scope) => {
          opens.push(scope);
          const cwd = `/work/${scope.name}/${opens.length}`;
          return () => envAt(cwd);
        },
        extensionsFor: () => [{ extension: where, tier: () => "read" }],
      });
    };
    /** The model calls `where` in a run of `name`'s session, a new one without `sessionId`; returns the call's end. */
    const ask = async (name: string, sessionId: string | undefined, toolCallId: string) => {
      const instance = runtime!.get(agent, name);
      const id = sessionId ?? (await instance.createSession()).id;
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("where", {}, { id: toolCallId }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Done."),
      ]);
      const session = instance.session(id);
      await session.submit({ text: "Where?", requestId: toolCallId });
      const ended = ({ event }: StreamItem) => event.type === "tool:end" && event.toolCallId === toolCallId;
      const items = await readUntil(session, (event, read) => isRunEnd(event) && read.some(ended));
      return { id, end: items.find(ended)?.event };
    };

    start();
    const alice = await ask("alice", undefined, "w-1");
    const bob = await ask("bob", undefined, "w-2");
    expect(alice.end).toMatchObject({ toolName: "where", status: "ok", details: { cwd: "/work/alice/1" } });
    expect(bob.end).toMatchObject({ status: "ok", details: { cwd: "/work/bob/2" } });
    await runtime!.close();

    // A reopened instance resolves it again: its tools read the environment of this open.
    start();
    expect((await ask("alice", alice.id, "w-3")).end).toMatchObject({
      status: "ok",
      details: { cwd: "/work/alice/3" },
    });
    expect(opens).toEqual([
      { kind: "coder", name: "alice" },
      { kind: "coder", name: "bob" },
      { kind: "coder", name: "alice" },
    ]);
  });

  it("gives a tool no environment without `envFor`", async () => {
    const { faux, models, model } = fauxModels();
    runtime = createAgentRuntime({
      agents: [agent],
      host: durableMemoryHost(),
      models,
      ports: {},
      defaultModel: model,
      extensionsFor: () => [{ extension: where, tier: () => "read" }],
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("where", {}, { id: "w-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    const instance = runtime.get(agent, "alice");
    const session = instance.session((await instance.createSession()).id);
    await session.submit({ text: "Where?", requestId: "1" });
    const items = await readUntil(session, isRunEnd);
    expect(items.find((item) => item.event.type === "tool:end")?.event).toMatchObject({ details: { cwd: null } });
  });

  it("fails the open when `envFor` throws", async () => {
    const { models, model } = fauxModels();
    runtime = createAgentRuntime({
      agents: [agent],
      host: durableMemoryHost(),
      models,
      ports: {},
      defaultModel: model,
      envFor: () => {
        throw new Error("No workspace for alice");
      },
    });
    await expect(runtime.get(agent, "alice").createSession()).rejects.toThrow("No workspace for alice");
  });
});
