// The host contract's own suite against the test hosts every other core test runs on, so their leases and storage
// behave as a shipped host's do.

import { describe, expect, it } from "vite-plus/test";

import { registerHostConformance } from "../src/testing.ts";

import { durableMemoryHost, memoryHost } from "./helpers.ts";

registerHostConformance({ describe, expect, it }, "memoryHost", async (use) => use(memoryHost()));
registerHostConformance({ describe, expect, it }, "durableMemoryHost", async (use) => use(durableMemoryHost()));
