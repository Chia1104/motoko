import { defineConfig, mergeConfig } from "vite-plus";

import shared from "../../vitest.shared.ts";

export default mergeConfig(
  shared,
  defineConfig({
    run: {
      tasks: {
        // This task is not cached. The TypeScript 7 compiler reads the sources from a native process that the
        // task runner does not trace, so a cached run would replay a pass after the sources changed.
        typecheck: { command: "tsc -p tsconfig.json", cache: false },
        // The task runner passes a task only the variables the task names, and keys the cache on them. Without the
        // URL the real-database cases skip. With it, a cached offline run is never replayed as a database run.
        test: { command: "vp test", cache: { env: ["TEST_DATABASE_URL"] } },
      },
    },
    test: {
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
);
