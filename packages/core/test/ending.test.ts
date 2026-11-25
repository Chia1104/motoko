import type { Storage, Wake } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createAgentRuntime, defineAgent, InstanceClosedError } from "../src/index.ts";
import type { AgentHost, AgentRuntime } from "../src/index.ts";

import { durableMemoryHost, eventually, fauxModels, memoryPlace } from "./helpers.ts";

const agent = defineAgent({ kind: "notes", instructions: "You keep notes.", tools: [] });

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function runtimeOn(host: AgentHost) {
  const { models, model } = fauxModels();
  const runtime = createAgentRuntime({ agents: [agent], host, models, ports: {}, defaultModel: model });
  runtimes.push(runtime);
  return runtime;
}

const closedFor = (reason: InstanceClosedError["reason"]) =>
  expect.objectContaining({ name: "InstanceClosedError", reason });

describe("close() while the instance opens", () => {
  it("ends it at once; the open under way releases what it took, and its call fails", async () => {
    const place = memoryPlace();
    const base = durableMemoryHost(place);
    let asked: () => void = () => undefined;
    const storageAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const host: AgentHost = {
      ...base,
      async storage(scope, lease) {
        asked();
        await answered;
        return base.storage(scope, lease);
      },
    };
    const runtime = runtimeOn(host);
    const instance = runtime.get(agent, "c");
    const opening = instance.open();
    await storageAsked;
    expect(instance.state).toBe("opening");
    expect(runtime.inspect().open).toBe(1);

    const closing = instance.close();
    expect(instance.state).toBe("closed");
    expect(runtime.inspect()).toEqual({ open: 0, instances: [expect.objectContaining({ state: "closed" })] });
    answer();
    await expect(opening).rejects.toEqual(closedFor("closed"));
    await closing;
    expect(place.log).toEqual(["acquire notes/c", "release notes/c"]);
    expect([...place.writers.values()]).toEqual([0]);
    expect(runtime.inspect()).toEqual({ open: 0, instances: [] });
    await expect(instance.listSessions()).rejects.toBeInstanceOf(InstanceClosedError);
  });

  it("fails a call waiting on an open past its last check for an end, and nothing it would do happens", async () => {
    const place = memoryPlace();
    const base = durableMemoryHost(place);
    let closing: Promise<void> | undefined;
    let closeNow: () => void = () => undefined;
    const touched: string[] = [];
    const host: AgentHost = {
      ...base,
      async lease(scope) {
        const lease = await base.lease(scope);
        const listen = lease.signal.addEventListener.bind(lease.signal);
        lease.signal.addEventListener = (...args: Parameters<typeof listen>) => {
          closeNow();
          listen(...args);
        };
        return lease;
      },
      async storage(scope, lease) {
        const storage = await base.storage(scope, lease);
        return new Proxy(storage, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              touched.push(String(property));
              return Reflect.apply(value, target, args);
            };
          },
        }) satisfies Storage;
      },
    };
    const runtime = runtimeOn(host);
    const instance = runtime.get(agent, "r");
    closeNow = () => {
      closeNow = () => undefined;
      closing = instance.close();
    };

    await expect(instance.createSession()).rejects.toEqual(closedFor("closed"));
    await closing;
    expect(touched.at(-1)).toBe("close");
    expect(place.log).toEqual(["acquire notes/r", "release notes/r"]);
    expect(await runtime.get(agent, "r").listSessions()).toEqual([]);
  });
});

describe("a lease lost while the instance is open", () => {
  it("ends it as lease_lost: calls fail, the lease is released, and a fresh handle opens the scope", async () => {
    const place = memoryPlace();
    const base = durableMemoryHost(place);
    let lose: () => void = () => undefined;
    const host: AgentHost = {
      ...base,
      async lease(scope) {
        const lease = await base.lease(scope);
        const lost = new AbortController();
        lose = () => lost.abort();
        return { signal: lost.signal, release: () => lease.release() };
      },
    };
    const runtime = runtimeOn(host);
    const instance = runtime.get(agent, "l");
    const { id } = await instance.createSession();
    lose();
    expect(instance.state).toBe("lease_lost");
    await expect(instance.listSessions()).rejects.toEqual(closedFor("lease_lost"));
    await eventually(() => runtime.inspect().instances.length === 0);
    expect(place.log).toEqual(["acquire notes/l", "release notes/l"]);

    const fresh = runtime.get(agent, "l");
    expect(fresh).not.toBe(instance);
    expect(await fresh.listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
  });
});

describe("a storage that fails while the instance is open", () => {
  it("ends it as failed: calls fail, the lease is released, and the runtime lets it go", async () => {
    const place = memoryPlace();
    const base = durableMemoryHost(place);
    let failing = false;
    const host: AgentHost = {
      ...base,
      async storage(scope, lease) {
        const storage = await base.storage(scope, lease);
        return new Proxy(storage, {
          get(target, property) {
            if (property === "commit" && failing) {
              return async () => {
                throw new Error("disk gone");
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) satisfies Storage;
      },
    };
    const runtime = runtimeOn(host);
    const instance = runtime.get(agent, "f");
    await instance.open();
    failing = true;
    await expect(instance.createSession()).rejects.toThrow();
    await eventually(() => instance.state === "failed");
    await expect(instance.listSessions()).rejects.toEqual(closedFor("failed"));
    await eventually(() => runtime.inspect().instances.length === 0);
    expect(place.log).toEqual(["acquire notes/f", "release notes/f"]);
  });

  it("releases its lease saying nothing of its work, so a host counts the scope as unfinished", async () => {
    const place = memoryPlace();
    const base = durableMemoryHost(place);
    let failing = false;
    const released: (Wake | undefined)[] = [];
    const host: AgentHost = {
      ...base,
      async lease(scope) {
        const lease = await base.lease(scope);
        return {
          signal: lease.signal,
          async release(wake) {
            released.push(wake);
            await lease.release();
          },
        };
      },
      async storage(scope, lease) {
        const storage = await base.storage(scope, lease);
        return new Proxy(storage, {
          get(target, property) {
            if (property === "commit" && failing) {
              return async () => {
                throw new Error("disk gone");
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) satisfies Storage;
      },
    };
    const runtime = runtimeOn(host);
    const instance = runtime.get(agent, "f");
    await instance.open();
    failing = true;
    await expect(instance.createSession()).rejects.toThrow();
    await eventually(() => released.length === 1);
    expect(released).toEqual([undefined]);

    const healthy = runtime.get(agent, "g");
    await healthy.open();
    await healthy.close();
    expect(released[1]).toMatchObject({ active: false });
  });
});
