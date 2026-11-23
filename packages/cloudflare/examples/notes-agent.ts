// pi and the Agents SDK are the app's own dependencies: its models come from them directly.
import { createModels } from "@earendil-works/pi-ai/models";
import { Agent, routeAgentRequest } from "agents";
import { createAI } from "agents/models/pi-ai";
import type { AI } from "agents/models/pi-ai";
import * as z from "zod";

import { MotokoCapability } from "@chia1104/motoko-cloudflare";
import { defineAgent, defineTool } from "@chia1104/motoko-core";
import type { ToolContext } from "@chia1104/motoko-core";

// The Worker's bindings, from its Wrangler configuration.
interface Env extends Cloudflare.Env {
  readonly AI: Ai;
  readonly NOTES: DurableObjectNamespace<NotesAgent>;
}

// ─── The definition: no ports, no credentials. ────────────────────────────────

interface NotesPorts {
  /** The object's own key-value storage, beside Motoko's tables. */
  readonly notes: SyncKvStorage;
}

const readNote = defineTool({
  name: "read_note",
  description: "Read a note by its key",
  tier: "read",
  replay: "safe",
  parameters: z.object({ key: z.string() }),
  async execute({ key }, { ports }: ToolContext<NotesPorts>) {
    return { text: ports.notes.get<string>(`note:${key}`) ?? "" };
  },
});

const writeNote = defineTool({
  name: "write_note",
  description: "Write a note",
  tier: "write",
  parameters: z.object({ key: z.string(), text: z.string() }),
  async execute({ key, text }, { ports }: ToolContext<NotesPorts>) {
    ports.notes.put(`note:${key}`, text);
    return { text: `Saved ${key}.` };
  },
});

const notesAgent = defineAgent<NotesPorts>({
  kind: "notes",
  instructions: "You keep the user's notes. Ask before writing one.",
  tools: [readNote, writeNote],
  policy: { requiresApproval: ["write"] }, // write-tier calls wait for the user
});

// ─── One object per user: its instance's scope is { kind: "notes", name: <the object's name> }. ─

/** pi-ai model access over Workers AI and AI Gateway: the Worker holds no provider key. */
function modelsOf(ai: AI) {
  const models = createModels();
  models.setProvider(ai.provider);
  return models;
}

export class NotesAgent extends Agent<Env> {
  readonly #ai = createAI({ binding: this.env.AI });
  readonly #model = this.#ai("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
  readonly motoko = new MotokoCapability<NotesPorts>({
    agent: notesAgent,
    models: modelsOf(this.#ai),
    defaultModel: { provider: this.#model.provider, modelId: this.#model.id },
    ports: { notes: this.ctx.storage.kv },
    // Motoko's socket protocol on the agent's own WebSockets, beside the app's frames: no onMessage to write.
    connections: this,
    // Closes the instance once idle (no socket following a session), which also erases the sessions the user deleted.
    closeIdleAfterMs: 60_000,
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.motoko);
  }

  // An RPC method of the app's, for its other Workers: the Agent starts its Lifecycle before each runs.
  async ask(sessionId: string, text: string, requestId: string): Promise<string> {
    const instance = await this.motoko.instance();
    return (await instance.session(sessionId).submit({ text, requestId })).submissionId;
  }
}

/** The signed-in user, by the app's own sign-in: a session cookie it verifies, say. Not Motoko's. */
declare function signedInUser(request: Request, env: Env): Promise<string | null>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Every connection to an object may make every call on its sessions, so the app lets each user reach their own
    // object alone (`/agents/notes/<user>`), before the request reaches it.
    const ownObjectOnly = async (incoming: Request, route: { readonly name: string }) => {
      const user = await signedInUser(incoming, env);
      if (user === null) return new Response("Unauthorized", { status: 401 });
      if (route.name !== user) return new Response("Forbidden", { status: 403 });
      return undefined;
    };
    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: ownObjectOnly,
      onBeforeRequest: ownObjectOnly,
    });
    return routed ?? new Response("Not found", { status: 404 });
  },
};
