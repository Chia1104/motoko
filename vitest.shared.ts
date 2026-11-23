import { defineConfig } from "vite-plus";

// Workspace packages resolve to their sources through their own export condition, never to a stale
// build. (pi's packages export a `source` condition for files they do not ship, so the name is ours.)
// Setting conditions replaces Vite's defaults, so they are listed after it.
const SOURCE = "@chia1104/motoko-source";

export default defineConfig({
  resolve: { conditions: [SOURCE, "module", "node", "development|production"] },
  ssr: { resolve: { conditions: [SOURCE, "module", "node", "development|production"] } },
  test: {
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: [/@chia1104\/runtime-/] } },
  },
});
