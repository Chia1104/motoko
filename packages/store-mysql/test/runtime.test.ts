import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import {
  createAgentRuntime,
  defineAgent,
  defineTool,
  LeaseHeldError as CoreLeaseHeldError,
} from "@chia1104/motoko-core";
import type { AgentSession } from "@chia1104/motoko-core";
import { nodeHost } from "@chia1104/motoko-node";
import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent } from "@chia1104/motoko-wire";

import { LeaseHeldError } from "../src/index.ts";

import { backendFactories, uniqueName } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

async function readUntil(session: AgentSession, until: (event: AgentWireEvent) => boolean): Promise<AgentWireEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const events: AgentWireEvent[] = [];
  try {
    for await (const { event } of session.events({ signal: controller.signal })) {
      events.push(event);
      if (until(event)) return events;
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`Stream ended before the expected event; read: ${events.map((event) => event.type).join(", ")}`);
}

for (const factory of backendFactories) {
  describe.skipIf(factory.skip)(`The runtime on ${factory.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await factory.open();
    });
    afterAll(async () => {
      await backend?.close();
    });

    it("runs a gated tool call under a fenced lease, and a second runtime takes the scope over", async () => {
      const sent: string[] = [];
      const notify = defineTool({
        name: "notify",
        description: "Send a notice",
        tier: "write",
        parameters: z.object({ text: z.string() }),
        async execute({ text }) {
          sent.push(text);
          return { text: `sent ${text}` };
        },
      });
      const agent = defineAgent({
        kind: uniqueName("ops"),
        instructions: "You send notices.",
        tools: [notify],
        policy: { requiresApproval: ["write"] },
      });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      const defaultModel = { provider: faux.provider.id, modelId: faux.getModel().id };
      const store = backend.storeWith({ ttlMs: 5_000 });
      const openRuntime = () =>
        createAgentRuntime({
          agents: [agent],
          host: nodeHost(store),
          models,
          ports: {},
          defaultModel,
        });

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("notify", { text: "deploy done" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Notified."),
      ]);
      const first = openRuntime();
      const instance = first.get(agent, "team");
      const { id } = await instance.createSession();
      const session = instance.session(id);
      await session.submit({ text: "Tell the team", requestId: "r1" });
      const asked = await readUntil(session, (event) => event.type === "approval:request");
      const request = asked.at(-1);
      if (request?.type !== "approval:request") throw new Error("No approval request");
      expect(sent).toEqual([]);

      const intruder = openRuntime();
      const refused = await intruder
        .get(agent, "team")
        .open()
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(LeaseHeldError);
      expect(refused).toBeInstanceOf(CoreLeaseHeldError);
      await intruder.close();

      await session.approve([{ toolCallId: request.toolCallId, approved: true }]);
      const live = await readUntil(session, (event) => event.type === "run:end");
      expect(sent).toEqual(["deploy done"]);
      expect(live.at(-1)).toEqual({ type: "run:end", reason: "done" });
      const view = foldEvents(live);
      expect(view.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
      await first.close();

      const second = openRuntime();
      const reopened = second.get(agent, "team");
      expect(await reopened.listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
      const replayed = await readUntil(reopened.session(id), (event) => event.type === "run:end");
      expect(foldEvents(replayed)).toEqual(view);
      await second.close();
    });
  });
}
