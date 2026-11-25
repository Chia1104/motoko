import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { registerStoreConformance } from "@chia1104/motoko-core/store/testing";
import type { StoreConformanceTarget } from "@chia1104/motoko-core/store/testing";
import { registerHostConformance } from "@chia1104/motoko-core/testing";
import { nodeHost } from "@chia1104/motoko-node";

import { createMysqlStore } from "../src/index.ts";
import type { MysqlLease, MysqlStorage } from "../src/index.ts";
import * as schema from "../src/schema.ts";

import { connectionReset, forceExpire, MYSQL_URL, mysqlBackend, newPool, statements } from "./helpers.ts";
import type { Backend } from "./helpers.ts";

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

const byKey = "scope_key = UNHEX(SHA2(CONCAT(?, X'00', ?), 256))";

function storeTarget(backend: Backend): StoreConformanceTarget<MysqlStorage> {
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
      await backend.query(`DELETE FROM agent_runtime_scopes WHERE ${byKey}`, [scope.kind, scope.name]);
    },
    async wake(scope) {
      const [row] = await backend.query<{ wake_active: number; wake_at: unknown }>(
        `SELECT wake_active, wake_at FROM agent_runtime_scopes WHERE ${byKey}`,
        [scope.kind, scope.name],
      );
      return row === undefined
        ? undefined
        : { active: row.wake_active === 1, at: row.wake_at === null ? undefined : Number(row.wake_at) };
    },
    rows: (storage) =>
      Promise.all(tables.map((table) => backend.app.$count(table, eq(table.scopeId, storage.scopeId)))),
    async otherProcess(options) {
      const pool = newPool(backend.url, 2);
      return { store: createMysqlStore(pool, options), exit: () => pool.end() };
    },
  };
}

describe.skipIf(MYSQL_URL === undefined)("conformance on MySQL", () => {
  let backend: Backend;
  beforeAll(async () => {
    backend = await mysqlBackend(MYSQL_URL as string);
  });
  afterAll(async () => {
    await backend?.close();
  });
  let cases = 0;

  registerStorageConformance({ describe, expect, it }, "MysqlStorage", async (use) => {
    const scope = { kind: "conformance", name: `case-${++cases}` };
    let lease: MysqlLease | undefined;
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

  registerStoreConformance({ describe, expect, it }, "MysqlStore", async (use) => use(storeTarget(backend)));
});
