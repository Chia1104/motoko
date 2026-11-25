// An alarm host stays armed active while a call that can start work is under way. pi-durable tells the host of that
// work through `onWake`, and only after its commit. An idle wake armed between the call's own arm and that commit would
// leave committed work that nothing wakes if the process died then.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Wake } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "../src/index.ts";
import type { AgentHost, AgentRuntime } from "../src/index.ts";

import { durableMemoryHost, eventually, fauxModels, isRunEnd, readUntil } from "./helpers.ts";

let release: () => void = () => undefined;
let holding: () => void = () => undefined;
const hold = defineTool({
  name: "hold",
  description: "Hold until released",
  tier: "read",
  parameters: z.object({}),
  async execute() {
    holding();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { text: "held" };
  },
});

const agent = defineAgent({ kind: "alarm", instructions: "You answer.", tools: [hold] });

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function setup() {
  const arms: Wake[] = [];
  const armedAtCommit: (Wake | undefined)[] = [];
  let paused: (() => Promise<void>) | undefined;
  const base = durableMemoryHost();
  const host: AgentHost = {
    ...base,
    async storage(scope, lease) {
      const storage = await base.storage(scope, lease);
      return new Proxy(storage, {
        get(target, property) {
          if (property !== "commit") return Reflect.get(target, property, target);
          return (...args: Parameters<typeof storage.commit>) => {
            armedAtCommit.push(arms.at(-1));
            return target.commit(...args);
          };
        },
      });
    },
    wake: {
      kind: "alarm",
      async arm(_scope, wake) {
        arms.push(wake);
        if (!wake.active || paused === undefined) return;
        const wait = paused;
        paused = undefined;
        await wait();
      },
    },
  };
  const { faux, models, model } = fauxModels();
  const runtime = createAgentRuntime({ agents: [agent], host, models, ports: {}, defaultModel: model });
  runtimes.push(runtime);
  const pauseNextActive = () => {
    let resume: () => void = () => undefined;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached: () => void = () => undefined;
    const armed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    paused = async () => {
      reached();
      await resumed;
    };
    return {
      armed: armed.then(() => arms.length - 1),
      resume,
    };
  };
  return { runtime, faux, arms, armedAtCommit, pauseNextActive };
}

describe("an alarm host", () => {
  it("stays armed active while a call starts work, though a call that started nothing finished meanwhile", async () => {
    const { runtime, faux, arms, armedAtCommit, pauseNextActive } = setup();
    faux.setResponses([fauxAssistantMessage("Done.")]);
    const instance = runtime.get(agent, "calls");
    const idle = instance.session((await instance.createSession()).id);
    const working = instance.session((await instance.createSession()).id);

    const pause = pauseNextActive();
    const submitted = working.submit({ text: "Work", requestId: "1" });
    const from = await pause.armed;
    await idle.abort();
    expect(arms.slice(from)).toEqual([{ active: true }, { active: true }, { active: true }]);

    const commits = armedAtCommit.length;
    pause.resume();
    await submitted;
    expect(armedAtCommit[commits]).toEqual({ active: true });
    await readUntil(working, isRunEnd);
    await eventually(() => arms.at(-1)?.active === false);
    expect(arms.at(-1)).toEqual({ active: false });
  });

  it("stays armed active while a call starts work, though another session's run ended meanwhile", async () => {
    const { runtime, faux, arms, armedAtCommit, pauseNextActive } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Held."),
      fauxAssistantMessage("Done."),
    ]);
    const instance = runtime.get(agent, "runs");
    const running = instance.session((await instance.createSession()).id);
    const working = instance.session((await instance.createSession()).id);
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    await running.submit({ text: "Hold", requestId: "1" });
    await held;

    const pause = pauseNextActive();
    const submitted = working.submit({ text: "Work", requestId: "2" });
    const from = await pause.armed;
    release();
    await readUntil(running, isRunEnd);
    await eventually(() => arms.length > from + 1);
    expect(arms.slice(from)).toEqual([{ active: true }, { active: true }]);

    const commits = armedAtCommit.length;
    pause.resume();
    await submitted;
    expect(armedAtCommit[commits]).toEqual({ active: true });
    await readUntil(working, isRunEnd);
    await eventually(() => arms.at(-1)?.active === false);
    expect(arms.at(-1)).toEqual({ active: false });
  });
});
