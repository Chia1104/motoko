// End to end: a pi-durable Harness on the store's storage with pi-ai's faux provider (no network). Ask, get an answer,
// close, reopen on the same scope, and read the transcript back.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { backendFactories, uniqueName } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

const textOf = (message: unknown): string => {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("");
};

async function transcriptOf(storage: Storage): Promise<{ kind: string; text: string }[]> {
  const page = await storage.scanEntries(
    { conversationId: ROOT_CONVERSATION_ID, order: "ascending" },
    100,
    undefined,
    context,
  );
  return page.items.map((entry) => ({ kind: entry.kind, text: (entry.model ?? []).map(textOf).join("") }));
}

for (const factory of backendFactories) {
  describe.skipIf(factory.skip)(`Harness end to end on ${factory.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await factory.open();
    });
    afterAll(async () => {
      await backend?.close();
    });

    it("answers a question, then reopens the same scope and reads the transcript back", async () => {
      const scope = { kind: "agent", name: uniqueName("e2e") };
      const faux = fauxProvider({ tokensPerSecond: 400 });
      const models = createModels();
      models.setProvider(faux.provider);
      const model = faux.getModel();
      const answer = "Paris is the capital of France, and it has been for a very long time indeed.";
      faux.setResponses([fauxAssistantMessage([fauxText(answer)])]);

      // The storage's statements are recorded; the lease's renewals go through the unrecorded store.
      const { store, recording } = backend.recording();
      const lease = await backend.store.lease(scope);
      const storage = await store.storage(scope, lease);
      recording.reset();
      const commits: { calls: number; statements: number }[] = [];
      const counting: Storage = new Proxy(storage, {
        get(target, property) {
          if (property === "commit") {
            return async (...args: Parameters<Storage["commit"]>) => {
              const before = recording.statements.length;
              const result = await target.commit(...args);
              commits.push({ calls: args[0].length, statements: recording.statements.length - before });
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const harness = await Harness.open(counting, { models, registry: createRegistry() }, context);
      const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
      const submission = await root.submit(
        { type: "input", content: "What is the capital of France?", requestId: "q-1" },
        context,
      );
      const settled = await submission.wait(context);
      expect(settled.status).toBe("done");
      if (settled.status !== "done" || settled.type !== "input") throw new Error("not answered");
      const stored = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      expect(textOf(stored?.model?.[0])).toBe(answer);
      await harness.close(context);
      await lease.release();

      // Every commit: two round trips, the read and one transaction sent as one query; none was a copy.
      expect(commits.length).toBeGreaterThan(0);
      for (const commit of commits) expect(commit.statements).toBe(2);
      // Each backend's counts are part of the test's output on purpose. A statement here is one query sent: one round
      // trip, however many statements a transaction packs into it.
      // oxlint-disable-next-line no-console
      console.info(
        `[${factory.name}] ${commits.length} Storage.commit() calls, ${commits.reduce((n, c) => n + c.calls, 0)} batches, ` +
          `${commits.reduce((n, c) => n + c.statements, 0)} statements (round trips)`,
      );

      // Reopen: a new lease, a new storage, a new Harness on the same scope.
      const lease2 = await backend.store.lease(scope);
      const reopened = await backend.store.storage(scope, lease2);
      const transcript = await transcriptOf(reopened);
      expect(transcript.map((item) => item.kind)).toContain(UserEntry.kind);
      expect(transcript.find((item) => item.kind === UserEntry.kind)?.text).toBe("What is the capital of France?");
      expect(transcript.find((item) => item.kind === AssistantEntry.kind)?.text).toBe(answer);

      const harness2 = await Harness.open(reopened, { models, registry: createRegistry() }, context);
      const root2 = await harness2.root(context);
      expect(root2.id).toBe(root.id);
      const again = await root2.submit(
        { type: "input", content: "What is the capital of France?", requestId: "q-1" },
        context,
      );
      // The same request ID finds the submission the first process admitted.
      expect(again.id).toBe(submission.id);
      const reread = await root2.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      expect(textOf(reread?.model?.[0])).toBe(answer);
      await harness2.close(context);
      await lease2.release();
    });
  });
}
