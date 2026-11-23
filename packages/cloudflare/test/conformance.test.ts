import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { registerSingleScopeHostConformance } from "@chia1104/motoko-core/testing";

import type { MotokoConformanceObject } from "./worker.ts";

/** Runs `work` inside a fresh object, where its storage can be used. */
function insideFreshObject(work: (object: MotokoConformanceObject) => Promise<void>): Promise<void> {
  return runInDurableObject(env.CONFORMANCE.getByName(crypto.randomUUID()), work);
}

registerSingleScopeHostConformance({ describe, expect, it }, "MotokoCapability's host", (use) =>
  insideFreshObject(async (object) => {
    // A case runs a runtime of its own on the host, and arms it: the object's alarm must not open the object's own
    // instance meanwhile, which would take the lease the case means to hold. The wake is the other tests' to check.
    await object.lifecycle.disableAlarms();
    await use(object.motoko.host, object.motoko.scope);
  }),
);

registerStorageConformance({ describe, expect, it }, "durableObjectStore, the capability's default store", (use) =>
  insideFreshObject(async (object) => {
    const { host, scope } = object.motoko;
    const lease = await host.lease(scope);
    const storage = await host.storage(scope, lease);
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      await lease.release();
    }
  }),
);
