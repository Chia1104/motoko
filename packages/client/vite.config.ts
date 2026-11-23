import { defineConfig, mergeConfig } from "vite-plus";

import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    run: {
      tasks: {
        // Not cached: the TypeScript 7 compiler reads the sources from a native process that the task runner
        // does not trace, so a cached run would replay a pass after the sources changed. The sources are checked
        // again as a browser sees them, without Node's globals, and so are the examples.
        typecheck: {
          command: "tsc -p tsconfig.json && tsc -p tsconfig.src.json && tsc -p examples/tsconfig.json",
          cache: false,
        },
      },
    },
    pack: {
      // The hook is an entry of its own, so an app without React takes none of it.
      entry: ["src/index.ts", "src/react.ts"],
      format: "esm",
      platform: "neutral",
      // Declarations from the sources alone: the tsconfig that also checks this file would pull in the root's
      // shared config and write its declaration beside it.
      dts: { tsconfig: "tsconfig.src.json" },
    },
  }),
);
