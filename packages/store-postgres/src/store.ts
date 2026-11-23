// The one public shape: a Motoko store over one database, which `nodeHost` of `@chia1104/motoko-node` makes a host
// (`createAgentRuntime({ host: nodeHost(store) })`). It is a shared-database store whose statements are Postgres's.

import { hostname } from "node:os";

import { createSharedStore } from "@chia1104/motoko-core/store";
import type { FencedLease, SharedStore, SharedStoreOptions } from "@chia1104/motoko-core/store";

import type { Database } from "./database.ts";
import { deleteScope } from "./delete-scope.ts";
import { eraseConversation } from "./erase.ts";
import { acquireLease, releaseLease, renewLeases } from "./lease.ts";
import { checkSchemaOf } from "./migrations.ts";
import { PostgresStorage } from "./storage.ts";
import { unfinishedScopes } from "./unfinished.ts";

export type PostgresStoreOptions = SharedStoreOptions;

/**
 * Many independent pi-durable storages (one per scope) in the runtime's tables of one database: the runtime's store,
 * which `nodeHost(store)` makes the host of a long-lived process. Its lease and storage come only as a pair: the
 * storage fences every commit with the lease's row, so a lease from anywhere else would fence nothing.
 */
export type PostgresStore = SharedStore<PostgresStorage>;

/** A scope's lease as `store.lease()` returns it; `store.storage()` fences every commit with its token. */
export type PostgresLease = FencedLease;

/** @internal The store over a Drizzle database; the root and `/pglite` entries build it for their driver. */
export function createStore(db: Database, options: PostgresStoreOptions = {}): PostgresStore {
  return createSharedStore(
    {
      name: "@chia1104/motoko-store-postgres",
      defaultHolder: `${hostname()}:${process.pid}`,
      acquire: (scope, holder, ttlMs) => acquireLease(db, scope, holder, ttlMs),
      renew: (leases, ttlMs) => renewLeases(db, leases, ttlMs),
      release: (lease, wake) => releaseLease(db, lease, wake),
      open: (lease, attempts) => PostgresStorage.open(db, lease, attempts),
      unfinished: (after, limit) => unfinishedScopes(db, after, limit),
      erase: (lease, id) => eraseConversation(db, lease, id),
      deleteScope: (scope, lease) => deleteScope(db, scope, lease),
      checkSchema: () => checkSchemaOf(db),
    },
    options,
  );
}
