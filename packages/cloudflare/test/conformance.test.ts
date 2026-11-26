import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { registerSingleScopeHostConformance } from "@chia1104/motoko-core/testing";

import type { MotokoConformanceObject } from "./worker.ts";

function insideFreshObject(work: (object: MotokoConformanceObject) => Promise<void>): Promise<void> {
  return runInDurableObject(env.CONFORMANCE.getByName(crypto.randomUUID()), work);
}

registerSingleScopeHostConformance({ describe, expect, it }, "MotokoCapability's host", (use) =>
  insideFreshObject(async (object) => {
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
