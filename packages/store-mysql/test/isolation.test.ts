import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { backendFactories, uniqueName } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

for (const factory of backendFactories) {
  describe.skipIf(factory.skip)(`scopes on ${factory.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await factory.open();
    });
    afterAll(async () => {
      await backend?.close();
    });

    it("opens a new scope with an INSERT, never DDL", async () => {
      const { store, recording } = backend.recording();
      const scope = { kind: "agent", name: uniqueName("no-ddl") };
      const lease = await store.lease(scope);
      const storage = await store.storage(scope, lease);
      await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
      expect(recording.statements.length).toBeGreaterThan(0);
      for (const sql of recording.statements) expect(sql).not.toMatch(/\b(create|alter|drop|truncate)\b/i);
      await lease.release();
    });
  });
}
