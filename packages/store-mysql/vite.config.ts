import { defineConfig, mergeConfig } from "vite-plus";

import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    run: {
      tasks: {
        // Not cached. The TypeScript 7 compiler reads the sources from a native process that the task runner does not
        // trace, so a cached run would replay a pass after the sources changed.
        typecheck: { command: "tsc -p tsconfig.src.json && tsc -p tsconfig.json", cache: false },
        // The task runner hands a task only the variables it names, and keys the cache on them. Without the URL the
        // real-database cases skip. With it, a cached offline run is never replayed as a database run.
        test: { command: "vp test", cache: { env: ["TEST_MYSQL_URL"] } },
      },
    },
    pack: {
      entry: { index: "src/index.ts", schema: "src/schema.ts", cli: "src/cli.ts" },
      format: "esm",
      platform: "node",
      target: "node22.19",
      // Declarations from the sources alone. The tsconfig that also checks this file would pull in the root's shared
      // config and write its declaration beside it.
      dts: { tsconfig: "tsconfig.src.json" },
      clean: true,
      sourcemap: true,
    },
    test: {
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
