import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { assertScope, createAgentRuntime, defineAgent } from "../src/index.ts";
import type { AgentHost, AgentRuntime, InstanceReport } from "../src/index.ts";

import { fauxModels, isRunEnd, memoryHost, readUntil } from "./helpers.ts";

let runtime: AgentRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("assertScope", () => {
  it("accepts kinds and names of 1 to 1024 well-formed characters", () => {
    for (const name of ["a", "Alice", "日本", "a/../b", "😀".repeat(1024), "x".repeat(1024)]) {
      expect(() => assertScope({ kind: "chat", name })).not.toThrow();
    }
  });

  it("refuses empty, overlong, ill-formed and NUL-holding parts, and non-strings", () => {
    const refused: [unknown, RegExp][] = [
      ["", /name must not be empty/],
      ["x".repeat(1025), /at most 1024 characters/],
      ["😀".repeat(1025), /at most 1024 characters/],
      ["a\uD800b", /well-formed Unicode/],
      ["\uDC00", /well-formed Unicode/],
      ["a\0b", /NUL/],
      [42, /must be a string/],
      [undefined, /must be a string/],
    ];
    for (const [name, message] of refused) {
      expect(() => assertScope({ kind: "chat", name: name as string })).toThrow(message);
    }
    expect(() => assertScope({ kind: "", name: "a" })).toThrow(/kind must not be empty/);
  });

  it("holds an agent's kind and an instance's name to the same rule", () => {
    expect(() => defineAgent({ kind: "a\0", instructions: "", tools: [] })).toThrow(/kind must not contain a NUL/);
    const agent = defineAgent({ kind: "chat", instructions: "", tools: [] });
    const { models } = fauxModels();
    runtime = createAgentRuntime({ agents: [agent], host: memoryHost(), models, ports: {} });
    expect(() => runtime!.get(agent, "\uD800")).toThrow(/well-formed/);
  });
});

describe("reports", () => {
  it("hand pi-durable's report through unchanged, beside the scope", async () => {
    const { faux, models, model } = fauxModels();
    const agent = defineAgent({ kind: "r", instructions: "Answer.", tools: [] });
    const reports: InstanceReport[] = [];
    let calls = 0;
    runtime = createAgentRuntime({
      agents: [agent],
      host: memoryHost(),
      // The generation's own access to the models throws: pi faults the task and reports it.
      models: () => {
        calls += 1;
        if (calls === 2) throw new Error("models down");
        return models;
      },
      ports: {},
      defaultModel: model,
      onReport: (report) => reports.push(report),
    });
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    const instance = runtime.get(agent, "x");
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Hello", requestId: "h" });
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(items.at(-1)?.event).toMatchObject({ type: "run:end", reason: "error", code: "faulted" });
    expect(reports).toEqual([
      {
        source: "pi",
        scope: { kind: "r", name: "x" },
        // Every field pi gave, the task and the reason included.
        report: {
          kind: "task_faulted",
          task: { id: expect.any(Number), kind: "pi.generation", conversationId: Number(id) },
          reason: "threw",
          error: expect.objectContaining({ message: "models down" }),
        },
      },
    ]);
  });

  it("give the runtime's own reports a shape of their own", async () => {
    const { faux, models, model } = fauxModels();
    const agent = defineAgent({ kind: "r", instructions: "Answer.", tools: [] });
    const reports: InstanceReport[] = [];
    let failing = false;
    const host: AgentHost = {
      ...memoryHost(),
      wake: {
        kind: "alarm",
        async arm(_scope, wake) {
          // Once the instance is open, pi's idle wake reports fail; the runtime's arming before work does not.
          if (failing && !wake.active) throw new Error("alarm unavailable");
        },
      },
    };
    runtime = createAgentRuntime({
      agents: [agent],
      host,
      models,
      ports: {},
      defaultModel: model,
      onReport: (r) => reports.push(r),
    });
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    const instance = runtime.get(agent, "x");
    const { id } = await instance.createSession();
    failing = true;
    await instance.session(id).submit({ text: "Hello", requestId: "h" });
    await readUntil(instance.session(id), isRunEnd);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reports.length).toBeGreaterThan(0);
    for (const report of reports) {
      expect(report).toEqual({
        source: "runtime",
        scope: { kind: "r", name: "x" },
        kind: "arm_failed",
        error: expect.objectContaining({ message: "alarm unavailable" }),
      });
    }
  });
});
