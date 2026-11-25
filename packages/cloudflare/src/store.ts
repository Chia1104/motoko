import {
  DurableObjectSqliteDatabase,
  openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

import { assertScope, inProcessLeases, scopeKey } from "@chia1104/motoko-core";
import type { AgentStore, StorageScope } from "@chia1104/motoko-core";
import { eraseConversations } from "@chia1104/motoko-core/sqlite";

export interface DurableObjectStoreOptions {
  /**
   * The prefix of pi-durable's tables in the object's SQLite database, so their names never collide with the Agents
   * SDK's `cf_agents_*` tables or the app's tables. Default: `motoko_`. Never use `_cf_`, which Durable Objects
   * reserve.
   */
  readonly prefix?: string;
}

/**
 * The store of one Durable Object. It is pi-durable's storage in the object's own SQLite database, for `scope` alone,
 * and it refuses any other scope with a `TypeError`. The lease is held in the object's memory. The platform runs one
 * instance of an object at a time, so the writer the lease admits is the only one. `erase` deletes a deleted session's
 * rows. The object's SQL API refuses `PRAGMA secure_delete`, so the rows' bytes are not overwritten before SQLite
 * reuses the pages.
 */
export function durableObjectStore(
  storage: DurableObjectStorage,
  scope: StorageScope,
  options: DurableObjectStoreOptions = {},
): AgentStore {
  assertScope(scope);
  const prefix = options.prefix ?? "motoko_";
  if (prefix.toLowerCase().startsWith("_cf_")) {
    throw new TypeError("A Durable Object store's prefix must not start with _cf_, which Durable Objects reserve");
  }
  const own = scopeKey(scope);
  const served = (asked: StorageScope) => {
    assertScope(asked);
    if (scopeKey(asked) !== own) {
      throw new TypeError(`This Durable Object's store serves its own scope ${own} alone, not ${scopeKey(asked)}`);
    }
  };
  const leases = inProcessLeases();
  return {
    async lease(asked) {
      served(asked);
      return leases(asked);
    },
    async storage(asked) {
      served(asked);
      return openDurableObjectSqliteStorage(storage, { prefix });
    },
    async erase(asked, _lease, conversations) {
      served(asked);
      await eraseConversations(new DurableObjectSqliteDatabase(storage), conversations, {
        prefix,
        label: "this Durable Object's database",
      });
    },
  };
}
