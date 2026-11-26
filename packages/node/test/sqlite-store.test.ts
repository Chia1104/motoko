import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "@chia1104/motoko-core";
import type { AgentRuntime, InstanceReport, StorageScope } from "@chia1104/motoko-core";

import { eraseSqliteConversations, nodeHost, scopeFile, sqliteScopes, sqliteStore } from "../src/index.ts";

import { eventually } from "./helpers.ts";

let blocking = true;
const wait = defineTool({
  name: "wait",
  description: "Wait",
  tier: "read",
  replay: "safe",
  parameters: z.object({}),
  async execute(_args, { signal }) {
    if (!blocking) return { text: "done" };
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { text: "stopped" };
  },
});

const agent = defineAgent({ kind: "chat", instructions: "Chat.", tools: [wait] });

let directory: string;
const runtimes: AgentRuntime[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-runtime-sqlite-host-"));
});
afterEach(async () => {
  blocking = true;
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await rm(directory, { recursive: true, force: true });
});

function runtimeOn(reports: InstanceReport[] = []) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = createAgentRuntime({
    agents: [agent],
    host: nodeHost(sqliteStore({ directory })),
    models,
    ports: {},
    defaultModel: { provider: faux.provider.id, modelId: faux.getModel().id },
    onReport: (report) => reports.push(report),
  });
  runtimes.push(runtime);
  return { runtime, faux };
}

async function scopesIn(directory: string): Promise<StorageScope[]> {
  const scopes: StorageScope[] = [];
  for await (const scope of sqliteScopes(directory)) scopes.push(scope);
  return scopes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

describe("sqliteScopes", () => {
  it("lists every scope with a file, names with a digest included, and nothing else", async () => {
    const long = "Alice-".repeat(40);
    const { runtime } = runtimeOn();
    for (const name of ["alice", "Bob/2", long]) await runtime.get(agent, name).open();
    await runtime.close();
    await writeFile(join(directory, "chat", "notes.txt"), "");
    await writeFile(join(directory, "stray.sqlite"), "");
    await mkdir(join(directory, "chat", "nested.sqlite"));
    expect((await readdir(join(directory, "chat"))).some((file) => file.endsWith(".scope.json"))).toBe(true);

    expect(await scopesIn(directory)).toEqual([
      { kind: "chat", name: long },
      { kind: "chat", name: "Bob/2" },
      { kind: "chat", name: "alice" },
    ]);
  });

  it("lists nothing for a directory that does not exist yet", async () => {
    expect(await scopesIn(join(directory, "missing"))).toEqual([]);
  });
});

describe("recover on sqliteStore", () => {
  it("carries on, in a new runtime, the run a closed one left in its file", async () => {
    const first = runtimeOn();
    first.faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}, { id: "w-1" }), { stopReason: "toolUse" })]);
    const instance = first.runtime.get(agent, "job");
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Work", requestId: "1" });
    await eventually(() => first.faux.state.callCount === 1);
    await first.runtime.close();

    blocking = false;
    const second = runtimeOn();
    second.faux.setResponses([fauxAssistantMessage("Picked up.")]);
    const result = await second.runtime.recover();
    expect(result).toEqual({ opened: [{ kind: "chat", name: "job" }], held: [], unknown: [], failed: [] });
    await eventually(() => second.faux.state.callCount === 1);
  });
});

describe("deleting a session on sqliteStore", () => {
  it("erases its content from the file once the instance closes, and keeps the other sessions", async () => {
    const reports: InstanceReport[] = [];
    const { runtime, faux } = runtimeOn(reports);
    const instance = runtime.get(agent, "eraser");
    const kept = await instance.createSession();
    const doomed = await instance.createSession();
    faux.setResponses([fauxAssistantMessage("Kept answer."), fauxAssistantMessage("Secret answer.")]);
    for (const [session, text] of [
      [kept, "Kept question"],
      [doomed, "Secret question 7f3a"],
    ] as const) {
      await instance.session(session.id).submit({ text, requestId: text });
      await eventually(() => faux.state.callCount === (session === kept ? 1 : 2));
    }
    await eventually(() => runtime.inspect().instances.every((held) => held.operations === 0));

    await instance.session(doomed.id).delete();
    await instance.close();
    expect(reports).toEqual([]);

    const file = scopeFile(directory, instance.scope);
    const bytes = await readFile(file);
    expect(bytes.includes("Secret question 7f3a")).toBe(false);
    expect(bytes.includes("Kept question")).toBe(true);
    const log = await readFile(`${file}-wal`).catch(() => Buffer.alloc(0));
    expect(log.includes("Secret question 7f3a")).toBe(false);
    const database = await openNodeSqliteDatabase(file);
    try {
      const rows = await database.all<{ id: number }>("SELECT id FROM conversations ORDER BY id");
      expect(rows.map((row) => String(row.id))).toEqual([kept.id]);
      const entries = await database.get<{ count: number }>(
        "SELECT count(*) AS count FROM entries WHERE conversation_id = ?",
        Number(doomed.id),
      );
      expect(entries?.count).toBe(0);
    } finally {
      await database.close();
    }
    expect(await runtime.get(agent, "eraser").listSessions()).toEqual([kept]);
  });

  it("erases nothing from a file that does not exist", async () => {
    await expect(eraseSqliteConversations(join(directory, "none.sqlite"), [])).resolves.toBeUndefined();
    await expect(
      eraseSqliteConversations(join(directory, "none.sqlite"), [2 as ConversationId]),
    ).resolves.toBeUndefined();
  });
});
