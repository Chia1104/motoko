import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "@chia1104/motoko-core";
import type { AgentRuntime, StorageScope } from "@chia1104/motoko-core";
import { nodeHost } from "@chia1104/motoko-node";

import { backendFactories, uniqueName, until } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

let blocking = true;
const wait = defineTool({
  name: "wait",
  description: "Wait",
  tier: "read",
  replay: "safe",
  parameters: z.object({}),
  async execute(_args, { signal }) {
    if (!blocking) return { text: "done" };
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { text: "stopped" };
  },
});

const agent = defineAgent({
  kind: uniqueName("recovery"),
  instructions: "You work.",
  tools: [wait],
});

async function listed(backend: Backend): Promise<StorageScope[]> {
  const scopes: StorageScope[] = [];
  for await (const scope of backend.store.unfinished()) scopes.push(scope);
  return scopes;
}

const has = (scopes: readonly StorageScope[], name: string) => scopes.some((scope) => scope.name === name);

for (const factory of backendFactories) {
  describe(`recovery on ${factory.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await factory.open();
    });
    afterAll(async () => {
      await backend?.close();
    });

    function runtimeOn() {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const runtime: AgentRuntime = createAgentRuntime({
        agents: [agent],
        host: nodeHost(backend.store),
        models,
        ports: {},
        defaultModel: { provider: faux.provider.id, modelId: faux.getModel().id },
      });
      return { runtime, faux };
    }

    it("carries on, in another runtime, the run a closed one left", async () => {
      const first = runtimeOn();
      first.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("wait", {}, { id: "w-1" }), { stopReason: "toolUse" }),
      ]);
      const name = uniqueName("job");
      const instance = first.runtime.get(agent, name);
      const { id } = await instance.createSession();
      await instance.session(id).submit({ text: "Work", requestId: "1" });
      await until(() => first.faux.state.callCount === 1);
      await first.runtime.close();

      blocking = false;
      try {
        const second = runtimeOn();
        second.faux.setResponses([fauxAssistantMessage("Picked up.")]);
        const result = await second.runtime.recover();
        expect(result.opened).toContainEqual({ kind: agent.kind, name });
        expect(result.failed).toEqual([]);
        await until(() => second.faux.state.callCount === 1, 10_000);
        for await (const { event } of second.runtime.get(agent, name).session(id).events()) {
          if (event.type === "run:end") break;
        }
        await second.runtime.close();
        expect(has(await listed(backend), name)).toBe(false);
      } finally {
        blocking = true;
      }
    });
  });
}
