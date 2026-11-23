import {
  DurableObjectSqliteDatabase,
  openDurableObjectSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

import { assertScope, inProcessLeases, scopeKey } from "@chia1104/motoko-core";
import type { AgentStore, StorageScope } from "@chia1104/motoko-core";
import { eraseConversations } from "@chia1104/motoko-core/sqlite";

export interface DurableObjectStoreOptions {
  /**
   * The prefix of pi-durable's tables in the object's SQLite database, so they never meet the Agents SDK's
   * (`cf_agents_*`) or the app's. Default `motoko_`. Never `_cf_`, which Durable Objects reserve.
   */
  readonly prefix?: string;
}

/**
 * The store of one Durable Object: pi-durable's storage in the object's own SQLite database, for `scope` and no other
 * scope, which it refuses with a `TypeError`. The lease is held in the object's memory: the platform runs one instance
 * of an object at a time, so the writer it admits is the only one. `erase` deletes a deleted session's rows; the
 * object's SQL API refuses `PRAGMA secure_delete`, so their bytes are not overwritten before SQLite reuses the pages.
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
