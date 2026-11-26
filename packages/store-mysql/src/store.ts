import { hostname } from "node:os";

import { createSharedStore } from "@chia1104/motoko-core/store";
import type { FencedLease, SharedStore, SharedStoreOptions } from "@chia1104/motoko-core/store";

import type { PoolDatabase } from "./database.ts";
import { deleteScope } from "./delete-scope.ts";
import { eraseConversation } from "./erase.ts";
import { acquireLease, releaseLease, renewLeases } from "./lease.ts";
import { checkSchemaOf } from "./migrations.ts";
import { openStorage } from "./storage.ts";
import type { MysqlStorage } from "./storage.ts";
import { unfinishedScopes } from "./unfinished.ts";

export type MysqlStoreOptions = SharedStoreOptions;

/**
 * Many independent pi-durable storages, one per scope, in the runtime's tables of one database. It is the runtime's
 * store, which `nodeHost(store)` makes the host of a long-lived process. Its lease and storage come only as a pair,
 * because the storage fences every commit with the lease's row. A lease from anywhere else would fence nothing.
 */
export type MysqlStore = SharedStore<MysqlStorage>;

/** A scope's lease, as `store.lease()` returns it. `store.storage()` fences every commit with its token. */
export type MysqlLease = FencedLease;

export function createStore(db: PoolDatabase, options: MysqlStoreOptions = {}): MysqlStore {
  return createSharedStore(
    {
      name: "@chia1104/motoko-store-mysql",
      defaultHolder: `${hostname()}:${process.pid}`,
      acquire: (scope, holder, ttlMs) => acquireLease(db, scope, holder, ttlMs),
      renew: (leases, ttlMs) => renewLeases(db, leases, ttlMs),
      release: (lease, wake) => releaseLease(db, lease, wake),
      open: (lease, attempts) => openStorage(db, lease, attempts),
      unfinished: (after, limit) => unfinishedScopes(db, after, limit),
      erase: async (lease, id) => (await eraseConversation(db, lease, id)) === "lease-held",
      deleteScope: (scope, lease) => deleteScope(db, scope, lease),
      checkSchema: () => checkSchemaOf(db),
    },
    options,
  );
}
