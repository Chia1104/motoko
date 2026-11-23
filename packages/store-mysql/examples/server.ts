// A Node server whose agent instances live in MySQL: every user gets an instance, several server processes may share
// the database, and a process that starts carries on what a stopped or crashed one left.

import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import mysql from "mysql2/promise";

import { createAgentRuntime, defineAgent, LeaseHeldError } from "@chia1104/motoko-core";
import { nodeHost } from "@chia1104/motoko-node";
import { createMysqlStore, migrate } from "@chia1104/motoko-store-mysql";

const assistant = defineAgent({
  kind: "assistant",
  instructions: "You are a helpful assistant.",
  tools: [],
  model: { provider: "openai", modelId: "gpt-6-sol" },
});

const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

// A pool for Motoko alone: the store sends multi-statement queries, which no other code should share. The store
// borrows its connections and never closes it.
const pool = mysql.createPool({
  uri: process.env.DATABASE_URL ?? "mysql://localhost/app",
  connectionLimit: 10,
  multipleStatements: true,
});
// Usually the `motoko-store-mysql migrate` CLI at deploy time; idempotent, and serialized across processes.
await migrate(pool);

const runtime = createAgentRuntime({
  agents: [assistant],
  host: nodeHost(createMysqlStore(pool, { ttlMs: 30_000 })),
  models,
  ports: {},
  closeIdleAfterMs: 5 * 60_000,
});

// Carry on what a previous process left; again every lease TTL or so, for one that crashed.
await runtime.recover();
const recovering = setInterval(() => void runtime.recover(), 30_000);

const instance = runtime.get(assistant, "user-42");
try {
  await instance.open();
} catch (error) {
  // Another server process holds this user's instance: route the request there, or retry after its lease expires.
  if (error instanceof LeaseHeldError) throw new Error("Another process serves user-42");
  throw error;
}

const [existing] = await instance.listSessions();
const session = instance.session(existing?.id ?? (await instance.createSession()).id);
await session.submit({ text: "What can you do?", requestId: "msg-1" });

for await (const { event } of session.events()) {
  if (event.type === "assistant:delta") process.stdout.write(event.delta);
  if (event.type === "run:end") break;
}

process.on("SIGTERM", () => {
  clearInterval(recovering);
  void runtime.close().then(() => pool.end());
});
