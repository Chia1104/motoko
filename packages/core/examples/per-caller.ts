import type { AuthContext, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "@chia1104/motoko-core";
import type { AgentHost, ToolContext } from "@chia1104/motoko-core";

// A host whose storage outlives an instance: @chia1104/motoko-node's, or Postgres's.
declare const host: AgentHost;

// ─── The app's own tables (a database in a real server) ───────────────────────

const apiKeys = new Map<string, string>(); // user id → that user's Anthropic key
const webGrants = new Set<string>(); // "<user>/<session>" pairs allowed to search the web

// ─── A definition: no ports, no credentials ───────────────────────────────────

interface AssistantPorts {
  readonly user: string;
  /** Present only in sessions the user granted web search. */
  readonly web?: { search(query: string): Promise<string> };
}

const webSearch = defineTool({
  name: "web_search",
  description: "Search the web",
  tier: "read",
  replay: "safe",
  parameters: z.object({ query: z.string() }),
  async execute({ query }, { ports }: ToolContext<AssistantPorts>) {
    if (ports.web === undefined) return { text: "Web search is not enabled in this conversation." };
    return { text: await ports.web.search(query) };
  },
});

const assistant = defineAgent<AssistantPorts>({
  kind: "assistant",
  instructions: "You are a helpful assistant.",
  tools: [webSearch],
  model: { provider: "anthropic", modelId: "claude-sonnet-5" },
});

// ─── One user's model access ──────────────────────────────────────────────────

/** The user's key, read from the app's table at every model request. */
function userCredentials(user: string): CredentialStore {
  const read = async (): Promise<Credential | undefined> => {
    const key = apiKeys.get(user);
    return key === undefined ? undefined : { type: "api_key", key };
  };
  return {
    read,
    list: async () => (apiKeys.has(user) ? [{ providerId: "anthropic", type: "api_key" }] : []),
    async modify(_providerId, change) {
      const next = await change(await read());
      if (next?.type === "api_key" && next.key !== undefined) apiKeys.set(user, next.key);
      return next ?? (await read());
    },
    delete: async () => void apiKeys.delete(user),
  };
}

// No environment variables or files: a user without a key never falls back to the server's own.
const noAmbientAuth: AuthContext = { env: async () => undefined, fileExists: async () => false };

// ─── The runtime: one instance per user, so the scope is the credential boundary ─

const runtime = createAgentRuntime({
  agents: [assistant],
  host,
  // Resolved when the user's instance opens (also after a restart) and before each submit.
  modelsFor: (scope) => {
    const models = createModels({ credentials: userCredentials(scope.name), authContext: noAmbientAuth });
    models.setProvider(anthropicProvider());
    return models;
  },
  // Resolved for every tool call, right before it runs: a grant withdrawn reaches the next call.
  portsFor: async ({ scope, sessionId }) => ({
    user: scope.name,
    ...(webGrants.has(`${scope.name}/${sessionId}`) && {
      web: { search: async (query: string) => `Results for ${query}` },
    }),
  }),
  // A user who went quiet gives back their Harness and lease after ten minutes.
  closeIdleAfterMs: 10 * 60_000,
});

/** A request handler: the authenticated user reaches their own instance and nobody else's. */
export async function handleMessage(userId: string, sessionId: string, text: string, requestId: string) {
  const session = runtime.get(assistant, userId).session(sessionId);
  return session.submit({ text, requestId });
}

// The user adds a key, or grants web search to a session: nothing to reopen, the next request or
// call reads the tables.
apiKeys.set("user-42", "sk-ant-...");
webGrants.add("user-42/1");

console.log("open instances:", runtime.inspect().open);
