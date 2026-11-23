// pi is the app's own dependency: its models, providers and storages come from it directly.
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { MemoryStorage } from "@earendil-works/pi-durable";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool, inProcessLeases } from "@chia1104/motoko-core";
import type { AgentHost, ToolContext } from "@chia1104/motoko-core";

// ─── Definitions: no ports, no credentials; a client may import them. ─────────

interface NotesPorts {
  readonly notes: Map<string, string>;
}

const readNote = defineTool({
  name: "read_note",
  description: "Read a note by its key",
  label: "Read note",
  tier: "read",
  replay: "safe", // reading twice after a crash duplicates nothing
  parameters: z.object({ key: z.string(), maxChars: z.number().int().optional() }),
  async execute({ key, maxChars }, { ports }: ToolContext<NotesPorts>) {
    const text = ports.notes.get(key) ?? "";
    return { text: text.slice(0, maxChars ?? text.length), details: { key, found: ports.notes.has(key) } };
  },
});

const deleteNote = defineTool({
  name: "delete_note",
  description: "Delete a note",
  tier: "write",
  parameters: z.object({ key: z.string() }),
  async execute({ key }, { ports }: ToolContext<NotesPorts>) {
    ports.notes.delete(key);
    return { text: `Deleted ${key}.` };
  },
});

export const notesAgent = defineAgent<NotesPorts>({
  kind: "notes",
  instructions: "You manage the user's notes. Ask before deleting anything.",
  tools: [readNote, deleteNote],
  policy: { requiresApproval: ["write"] }, // write-tier calls wait for an operator
  model: { provider: "anthropic", modelId: "claude-sonnet-5" },
});

// ─── A host: storage, a single writer, wake-ups. ──────────────────────────────

const host: AgentHost = {
  wake: { kind: "process" }, // a long-lived process: pi-durable's own timers wake sleeping work
  lease: inProcessLeases(), // one writer per scope within this process
  async storage() {
    return new MemoryStorage();
  },
};

// ─── The runtime: definitions bound to a host, models and ports. ────────────────

const models = createModels();
models.setProvider(anthropicProvider()); // reads ANTHROPIC_API_KEY

const runtime = createAgentRuntime({ agents: [notesAgent], host, models, ports: { notes: new Map() } });

const alice = runtime.get(notesAgent, "alice"); // one named instance: one Harness over its storage
const { id } = await alice.createSession();
const session = alice.session(id);

await session.submit({ text: "Delete my shopping note", requestId: crypto.randomUUID() });

for await (const { cursor, event } of session.events()) {
  // `cursor` is where a reconnecting client resumes: session.events({ from: cursor })
  if (event.type === "approval:request") {
    await session.approve([{ toolCallId: event.toolCallId, approved: false, comment: "Keep it for now." }]);
  }
  if (event.type === "run:end") {
    console.log("run ended:", event.reason, "at", cursor);
    break;
  }
}

await runtime.close();
