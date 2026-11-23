import { createServer } from "node:http";

import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "@chia1104/motoko-core";
import { motokoHandler, nodeHost, nodeListener, sqliteStore } from "@chia1104/motoko-node";

const clock = defineTool({
  name: "clock",
  description: "The current time",
  tier: "read",
  replay: "safe",
  parameters: z.object({ timeZone: z.string().optional() }),
  async execute({ timeZone }) {
    return { text: new Date().toLocaleString("en-US", timeZone === undefined ? {} : { timeZone }) };
  },
});

const assistant = defineAgent({
  kind: "assistant",
  instructions: "You are a helpful assistant.",
  tools: [clock],
  model: { provider: "openai", modelId: "gpt-6-sol" },
});

const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

const runtime = createAgentRuntime({
  agents: [assistant],
  // One SQLite file per instance: ./data/assistant/<user>.sqlite
  host: nodeHost(sqliteStore({ directory: "./data" })),
  models,
  ports: {},
  closeIdleAfterMs: 5 * 60_000,
});

// Carry on what the previous process left unfinished, in every instance, before any call comes.
await runtime.recover();

// The app's own sign-in goes here. This demo takes one token per user, as a cookie, which EventSource sends too.
const users = new Map([["demo-token", "user-42"]]);

const handler = motokoHandler(runtime, {
  basePath: "/motoko",
  // Who is calling, and so which instance: each user has their own.
  resolve(request) {
    const token = /(?:^|;\s*)token=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
    const user = token === undefined ? undefined : users.get(token);
    if (user === undefined) return new Response("Sign in first", { status: 401 });
    return { agent: assistant, name: user };
  },
  // What the caller may do, call by call: here, anything but deleting a session.
  authorize: (_request, call) => call.method !== "deleteSession",
  onError: (error) => console.error(error),
});

const server = createServer(nodeListener(handler));
server.listen(3000, () => console.log("Motoko on http://localhost:3000/motoko"));

process.on("SIGTERM", () => {
  server.close();
  // A follow never ends on its own; its client reconnects to the next process after its last cursor.
  server.closeAllConnections();
  void runtime.close();
});
