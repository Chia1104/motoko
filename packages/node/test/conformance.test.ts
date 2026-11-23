// The host contract's suite against `nodeHost` as an app wires it: SQLite files in a directory of its own, and the
// process's shared default leases.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { registerHostConformance } from "@chia1104/motoko-core/testing";

import { nodeHost, sqliteStorage, sqliteStore } from "../src/index.ts";

registerHostConformance({ describe, expect, it }, "nodeHost on SQLite", async (use) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-runtime-conformance-"));
  try {
    await use(nodeHost({ storage: sqliteStorage({ directory }) }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

registerHostConformance({ describe, expect, it }, "sqliteStore", async (use) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-runtime-conformance-"));
  try {
    await use(nodeHost(sqliteStore({ directory })));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

registerHostConformance({ describe, expect, it }, "sqliteStore with a table prefix", async (use) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-runtime-conformance-"));
  try {
    await use(nodeHost(sqliteStore({ directory, sqlite: { prefix: "pi_" } })));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
