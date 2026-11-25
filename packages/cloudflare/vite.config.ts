import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, mergeConfig } from "vite-plus";

import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
    run: {
      tasks: {
        // This task is not cached. The TypeScript 7 compiler reads the sources from a native process that the
        // task runner does not trace, so a cached run would replay a pass after the sources changed.
        typecheck: { command: "tsc -p tsconfig.json && tsc -p examples/browser/tsconfig.json", cache: false },
      },
    },
    pack: {
      entry: ["src/index.ts"],
      format: "esm",
      platform: "neutral",
      dts: { tsconfig: "tsconfig.src.json" },
    },
    test: {
      // runtime.test.ts evicts with abortAllDurableObjects(), which reaches every object, including other files'.
      fileParallelism: false,
      testTimeout: 30_000,
    },
  }),
);
