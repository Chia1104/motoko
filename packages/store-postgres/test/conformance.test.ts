import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { registerStoreConformance } from "@chia1104/motoko-core/store/testing";
import type { StoreConformanceTarget } from "@chia1104/motoko-core/store/testing";
import { registerHostConformance } from "@chia1104/motoko-core/testing";
import { nodeHost } from "@chia1104/motoko-node";

import { createPostgresStore } from "../src/index.ts";
import type { PostgresLease, PostgresStorage } from "../src/index.ts";
import * as schema from "../src/schema.ts";

import {
  connectionReset,
  DATABASE_URL,
  forceExpire,
  newPool,
  pgliteBackend,
  postgresBackend,
  statements,
} from "./helpers.ts";
import type { Backend } from "./helpers.ts";

const targets: { name: string; open: () => Promise<Backend>; skip: boolean }[] = [
  { name: "PGlite", open: () => pgliteBackend(), skip: false },
  { name: "Postgres", open: () => postgresBackend(DATABASE_URL as string), skip: DATABASE_URL === undefined },
];

const tables = [
  schema.scopes,
  schema.recordIds,
  schema.conversations,
  schema.entries,
  schema.tasks,
  schema.submissions,
  schema.documents,
  schema.documentRevisions,
];

function storeTarget(backend: Backend): StoreConformanceTarget<PostgresStorage> {
  const url = backend.url;
  return {
    store: backend.store,
    storeWith: (options) => backend.storeWith(options),
    controlled(options) {
      const { store, recording } = backend.recording(options);
      return {
        store,
        beforeWrite(hook) {
          recording.before = async (sql) => {
            if (!statements.commitWrite.test(sql)) return;
            recording.before = undefined;
            await hook();
          };
        },
        sever() {
          recording.before = () => {
            throw connectionReset();
          };
        },
      };
    },
    expire: async (scope) => {
      await forceExpire(backend, scope);
    },
    remove: async (scope) => {
      await backend.query("DELETE FROM agent_runtime.scopes WHERE kind = $1 AND name = $2", [scope.kind, scope.name]);
    },
    async wake(scope) {
      const [row] = await backend.query<{ wake_active: boolean; wake_at: unknown }>(
        "SELECT wake_active, wake_at FROM agent_runtime.scopes WHERE kind = $1 AND name = $2",
        [scope.kind, scope.name],
      );
      return row === undefined
        ? undefined
        : { active: row.wake_active, at: row.wake_at === null ? undefined : Number(row.wake_at) };
    },
    rows: (storage) =>
      Promise.all(tables.map((table) => backend.app.$count(table, eq(table.scopeId, storage.scopeId)))),
    ...(url !== undefined && {
      async otherProcess(options) {
        const pool = newPool(url, 2);
        return { store: createPostgresStore(pool, options), exit: () => pool.end() };
      },
    }),
  };
}

for (const target of targets) {
  describe.skipIf(target.skip)(`conformance on ${target.name}`, () => {
    let backend: Backend;
    beforeAll(async () => {
      backend = await target.open();
    });
    afterAll(async () => {
      await backend?.close();
    });
    let cases = 0;

    registerStorageConformance({ describe, expect, it }, "PostgresStorage", async (use) => {
      const scope = { kind: "conformance", name: `case-${++cases}` };
      let lease: PostgresLease | undefined;
      try {
        lease = await backend.store.lease(scope);
        const storage = await backend.store.storage(scope, lease);
        try {
          await use(storage);
        } finally {
          await storage.close(BACKGROUND_CONTEXT);
        }
      } finally {
        await lease?.release();
      }
    });

    registerHostConformance({ describe, expect, it }, "nodeHost(store)", async (use) => use(nodeHost(backend.store)));

    registerStoreConformance({ describe, expect, it }, "PostgresStore", async (use) => use(storeTarget(backend)));
  });
}
