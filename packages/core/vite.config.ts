import { defineConfig, mergeConfig } from "vite-plus";

import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    run: {
      tasks: {
        // Not cached: the TypeScript 7 compiler reads the sources from a native process that the task runner
        // does not trace, so a cached run would replay a pass after the sources changed.
        typecheck: { command: "tsc -p tsconfig.json", cache: false },
      },
    },
    pack: {
      entry: {
        index: "src/index.ts",
        testing: "src/testing.ts",
        "store/index": "src/store/index.ts",
        "store/testing": "src/store/testing.ts",
        sqlite: "src/sqlite.ts",
      },
      format: "esm",
      platform: "neutral",
      // Dependencies and peers are never bundled: the app installs pi, and its package manager resolves one instance.

      // Declarations from the sources alone: the tsconfig that also checks this file would pull in the root's
      // shared config and write its declaration beside it.
      dts: { tsconfig: "tsconfig.src.json" },
    },
  }),
);
