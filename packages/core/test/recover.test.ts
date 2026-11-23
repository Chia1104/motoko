// `runtime.recover()`: opening the scopes a host lists as possibly unfinished, so their work carries
// on without a call. The host here records what each release leaves (`Lease.release(wake)`), as a
// database host does, and lists the scopes whose last open left work or never released.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Wake } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool, scopeKey } from "../src/index.ts";
import type { AgentHost, AgentRuntime, Lease, StorageScope } from "../src/index.ts";

import { durableMemoryHost, eventually, fauxModels, isRunEnd, memoryPlace, readUntil } from "./helpers.ts";
import type { MemoryPlace } from "./helpers.ts";

/** While `blocking`, runs until its call is stopped, as a long call that a closing process cuts off. */
let blocking = true;
const wait = defineTool({
  name: "wait",
  description: "Wait",
  tier: "read",
  replay: "safe",
  parameters: z.object({}),
  async execute(_args, { signal }) {
    if (!blocking) return { text: "done" };
    // A call that starts while its instance closes finds its signal aborted already.
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { text: "stopped" };
  },
});

const agent = defineAgent({ kind: "worker", instructions: "You work.", tools: [wait] });

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  blocking = true;
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

/**
 * A host on `place` that records each scope's state as its lease is released, and lists as unfinished the scopes
 * whose last release left work or a sleep, and those acquired and never released.
 */
function recordingHost(place: MemoryPlace, extra: StorageScope[] = []) {
  const left = new Map<string, { scope: StorageScope; wake: Wake | undefined; released: boolean }>();
  const base = durableMemoryHost(place);
  const host: AgentHost = {
    ...base,
    async lease(scope): Promise<Lease> {
      const lease = await base.lease(scope);
      left.set(scopeKey(scope), { scope, wake: undefined, released: false });
      return {
        signal: lease.signal,
        async release(wake) {
          left.set(scopeKey(scope), { scope, wake, released: true });
          await lease.release();
        },
      };
    },
    async *unfinished() {
      for (const { scope, wake, released } of left.values()) {
        if (!released || wake === undefined || wake.active || wake.at !== undefined) yield scope;
      }
      yield* extra;
    },
  };
  return { host, left };
}

function setup(host: AgentHost, closeIdleAfterMs?: number) {
  const { faux, models, model } = fauxModels();
  const runtime = createAgentRuntime({
    agents: [agent],
    host,
    models,
    ports: {},
    defaultModel: model,
    ...(closeIdleAfterMs !== undefined && { closeIdleAfterMs }),
  });
  runtimes.push(runtime);
  return { runtime, faux };
}

describe("recover", () => {
  it("carries on a run a closed process left, without any call of the app's", async () => {
    const place = memoryPlace();
    const { host, left } = recordingHost(place);

    const first = setup(host);
    first.faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}, { id: "w-1" }), { stopReason: "toolUse" })]);
    const instance = first.runtime.get(agent, "job");
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Work", requestId: "1" });
    await readUntil(instance.session(id), (event) => event.type === "tool:start");
    // The process goes down mid-call: the release says work is left.
    await first.runtime.close();
    expect(left.get(scopeKey(instance.scope))?.wake).toMatchObject({ active: true });

    blocking = false;
    const second = setup(host);
    second.faux.setResponses([fauxAssistantMessage("Picked up.")]);
    expect(await second.runtime.recover()).toEqual({
      opened: [{ kind: "worker", name: "job" }],
      held: [],
      unknown: [],
      failed: [],
    });

    await eventually(() => second.faux.state.callCount === 1);
    const items = await readUntil(second.runtime.get(agent, "job").session(id), isRunEnd);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
  });

  it("lets go of a recovered instance with nothing to do once it is idle, which leaves nothing to recover", async () => {
    const place = memoryPlace();
    const { host, left } = recordingHost(place, [{ kind: "worker", name: "quiet" }]);
    const { runtime } = setup(host, 30);
    const result = await runtime.recover();
    expect(result.opened).toEqual([{ kind: "worker", name: "quiet" }]);
    await eventually(() => runtime.inspect().instances.length === 0);
    expect(left.get(scopeKey({ kind: "worker", name: "quiet" }))).toMatchObject({
      released: true,
      wake: { active: false },
    });
  });

  it("leaves a scope another writer holds to that writer, and skips kinds it does not have", async () => {
    const place = memoryPlace();
    const { host } = recordingHost(place, [{ kind: "other", name: "x" }]);
    const holder = setup(host);
    await holder.runtime.get(agent, "busy").open();

    const { runtime } = setup(host);
    expect(await runtime.recover({ concurrency: 1 })).toEqual({
      opened: [],
      held: [{ kind: "worker", name: "busy" }],
      unknown: [{ kind: "other", name: "x" }],
      failed: [],
    });
  });

  it("reports an open that fails and goes on with the rest", async () => {
    const place = memoryPlace();
    const { host: recording } = recordingHost(place, [
      { kind: "worker", name: "broken" },
      { kind: "worker", name: "fine" },
    ]);
    const host: AgentHost = {
      ...recording,
      async storage(scope, lease) {
        if (scope.name === "broken") throw new Error("disk gone");
        return recording.storage(scope, lease);
      },
    };
    const { runtime } = setup(host);
    const result = await runtime.recover();
    expect(result.opened).toEqual([{ kind: "worker", name: "fine" }]);
    expect(result.failed).toMatchObject([
      { scope: { kind: "worker", name: "broken" }, error: { message: "disk gone" } },
    ]);
  });

  it("needs a host that can list unfinished scopes, and a positive concurrency", async () => {
    const { runtime } = setup(durableMemoryHost());
    await expect(runtime.recover()).rejects.toBeInstanceOf(TypeError);
    const { runtime: listing } = setup(recordingHost(memoryPlace()).host);
    await expect(listing.recover({ concurrency: 0 })).rejects.toBeInstanceOf(TypeError);
  });
});
