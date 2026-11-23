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
      entry: ["src/index.ts"],
      format: "esm",
      platform: "node",
      // Declarations from the sources alone: the tsconfig that also checks this file would pull in the root's
      // shared config and write its declaration beside it.
      dts: { tsconfig: "tsconfig.src.json" },
      fixedExtension: false,
    },
  }),
);
