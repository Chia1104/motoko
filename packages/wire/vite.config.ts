import { defineConfig, mergeConfig } from "vite-plus";

import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    run: {
      tasks: {
        // The task is not cached. The TypeScript 7 compiler reads the sources from a native process that the task
        // runner does not trace, so a cached run would replay a pass after the sources changed.
        typecheck: { command: "tsc -p tsconfig.json", cache: false },
      },
    },
    pack: {
      entry: ["src/index.ts", "src/socket.ts"],
      format: "esm",
      platform: "neutral",
      dts: { tsconfig: "tsconfig.src.json" },
    },
  }),
);
