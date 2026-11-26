import { describe, expect, it } from "vite-plus/test";

import { registerHostConformance } from "../src/testing.ts";

import { durableMemoryHost, memoryHost } from "./helpers.ts";

registerHostConformance({ describe, expect, it }, "memoryHost", async (use) => use(memoryHost()));
registerHostConformance({ describe, expect, it }, "durableMemoryHost", async (use) => use(durableMemoryHost()));
