import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, mergeConfig } from "vite-plus";

import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    // The tests run inside workerd: an Agent and a plain Durable Object from test/worker.ts, as wrangler would run them.
    plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
    run: {
      tasks: {
        // Not cached: the TypeScript 7 compiler reads the sources from a native process that the task runner
        // does not trace, so a cached run would replay a pass after the sources changed.
        typecheck: { command: "tsc -p tsconfig.json && tsc -p examples/browser/tsconfig.json", cache: false },
      },
    },
    pack: {
      entry: ["src/index.ts"],
      format: "esm",
      platform: "neutral",
      // Dependencies and peers are never bundled: the app installs pi and the Agents SDK.

      // Declarations from the sources alone: the tsconfig that also checks this file would pull in the root's
      // shared config and write its declaration beside it.
      dts: { tsconfig: "tsconfig.src.json" },
    },
    test: {
      // runtime.test.ts evicts with abortAllDurableObjects(), which reaches every object, other files' too.
      fileParallelism: false,
      testTimeout: 30_000,
    },
  }),
);
