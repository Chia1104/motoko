import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  createAgentRuntime,
  defineAgent,
  inProcessLeases,
  InstanceClosedError,
  LeaseHeldError,
} from "@chia1104/motoko-core";
import type { AgentRuntime, Lease, StorageScope } from "@chia1104/motoko-core";

import { nodeHost, scopeFile, scopeFileSegment, sqliteStorage } from "../src/index.ts";
import type { NodeStore } from "../src/index.ts";

const memoryStorage = async () => new MemoryStorage();

interface TokenLease extends Lease {
  readonly token: number;
}

const agent = defineAgent({ kind: "chat", instructions: "Chat.", tools: [] });
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const defaultModel = { provider: faux.provider.id, modelId: faux.getModel().id };

let directory: string;
const runtimes: AgentRuntime[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-runtime-host-"));
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await rm(directory, { recursive: true, force: true });
});

function runtimeOn(host: ReturnType<typeof nodeHost>) {
  const runtime = createAgentRuntime({ agents: [agent], host, models, ports: {}, defaultModel });
  runtimes.push(runtime);
  return runtime;
}

describe("the lease", () => {
  it("refuses a second writer for the same scope, and admits it once released", async () => {
    const first = runtimeOn(nodeHost({ storage: sqliteStorage({ directory }) }));
    const second = runtimeOn(nodeHost({ storage: sqliteStorage({ directory }) }));
    await first.get(agent, "x").open();

    await expect(second.get(agent, "x").open()).rejects.toBeInstanceOf(LeaseHeldError);
    await expect(second.get(agent, "x").createSession()).rejects.toBeInstanceOf(LeaseHeldError);
    await second.get(agent, "y").open();

    await first.close();
    const { id } = await second.get(agent, "x").createSession();
    expect(await second.get(agent, "x").listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
  });

  it("closes the instance when the lease is lost", async () => {
    let controller = new AbortController();
    const leases = inProcessLeases();
    const runtime = runtimeOn(
      nodeHost({
        storage: memoryStorage,
        async lease(scope): Promise<Lease> {
          const held = await leases(scope);
          controller = new AbortController();
          return { signal: controller.signal, release: () => held.release() };
        },
      }),
    );
    faux.setResponses([fauxAssistantMessage("Hi.")]);
    const instance = runtime.get(agent, "x");
    const { id } = await instance.createSession();
    const reading = instance.session(id).events()[Symbol.asyncIterator]().next();
    await new Promise((resolve) => setTimeout(resolve, 20));

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(instance.session(id).submit({ text: "x", requestId: "x" })).rejects.toBeInstanceOf(
      InstanceClosedError,
    );
    expect(await reading).toEqual({ done: true, value: undefined });
    const reopened = runtime.get(agent, "x");
    expect(reopened).not.toBe(instance);
    await reopened.open();
  });

  it("is the store's own at its storage, so a storage that takes a narrower lease comes with its lease", async () => {
    const leases = inProcessLeases();
    let made = 0;
    const lease = async (scope: StorageScope): Promise<TokenLease> => ({ ...(await leases(scope)), token: ++made });
    const tokens: (number | undefined)[] = [];
    const tokenStorage = async (_scope: StorageScope, held: TokenLease) => {
      tokens.push(held.token);
      return new MemoryStorage();
    };

    const alone: NodeStore = { storage: memoryStorage };
    const leased: NodeStore<TokenLease> = { lease, storage: (at, held) => tokenStorage(at, held) };
    // @ts-expect-error Without its `lease`, the storage gets `processLeases`' lease, which has no `token`.
    const split: NodeStore<TokenLease> = { storage: tokenStorage };
    const scope = { kind: "chat", name: "token" };
    for (const host of [
      nodeHost({ storage: memoryStorage }),
      nodeHost(alone),
      nodeHost({ lease, storage: (at, held) => tokenStorage(at, held) }),
      nodeHost(leased),
      nodeHost(split),
    ]) {
      const held = await host.lease(scope);
      await host.storage(scope, held);
      await held.release();
    }
    expect(tokens).toEqual([1, 2, undefined]);
  });
});

describe("storage", () => {
  it("maps every scope to its own file, case and odd characters included", () => {
    expect(scopeFileSegment("alice")).toBe("alice");
    expect(scopeFileSegment("Alice")).toBe("%41lice");
    expect(scopeFileSegment("a/../b")).toBe("a%2F%2E%2E%2Fb");
    expect(scopeFileSegment("日本")).toBe("%E6%97%A5%E6%9C%AC");
    const long = scopeFileSegment("x".repeat(500));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).not.toBe(scopeFileSegment(`${"x".repeat(499)}y`));
    expect(scopeFile("/data", { kind: "chat", name: "Bob" })).toBe(join("/data", "chat", "%42ob.sqlite"));
  });

  it("keeps nothing in memory storage once the instance closes", async () => {
    const host = nodeHost({ storage: memoryStorage, lease: inProcessLeases() });
    const first = runtimeOn(host);
    await first.get(agent, "m").createSession();
    await first.close();
    const second = runtimeOn(host);
    expect(await second.get(agent, "m").listSessions()).toEqual([]);
  });
});

describe("idle instances on SQLite", () => {
  it("close and release the lease to another runtime; a held handle reopens the same file", async () => {
    const leases = inProcessLeases();
    const idleRuntime = createAgentRuntime({
      agents: [agent],
      host: nodeHost({ storage: sqliteStorage({ directory }), lease: leases }),
      models,
      ports: {},
      defaultModel,
      closeIdleAfterMs: 30,
    });
    runtimes.push(idleRuntime);
    faux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
    const instance = idleRuntime.get(agent, "idle");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "First", requestId: "1" });
    await readUntil(session, (type) => type === "run:end");
    const deadline = Date.now() + 5_000;
    while (instance.state !== "dormant") {
      if (Date.now() > deadline) throw new Error(`never closed: ${instance.state}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const other = runtimeOn(nodeHost({ storage: sqliteStorage({ directory }), lease: leases }));
    expect(await other.get(agent, "idle").listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
    await other.get(agent, "idle").close();

    await session.submit({ text: "Second", requestId: "2" });
    const items = await readUntil(session, (_type, ends) => ends === 2);
    expect(items.filter((type) => type === "user")).toHaveLength(2);
  });
});

async function readUntil(
  session: ReturnType<ReturnType<AgentRuntime["get"]>["session"]>,
  until: (type: string, runEnds: number) => boolean,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const types: string[] = [];
  try {
    for await (const { event } of session.events({ signal: controller.signal })) {
      types.push(event.type);
      if (until(event.type, types.filter((type) => type === "run:end").length)) return types;
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error(`Stream ended early: ${types.join(", ")}`);
}
