// Closing idle instances: `closeIdleAfterMs`. The idle times are short and the waits real, so each
// "stays open" check waits several idle times and each "closes" check polls.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Wake } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { foldEvents } from "@chia1104/motoko-wire";

import { createAgentRuntime, defineAgent, defineTool, InstanceClosedError, LeaseHeldError } from "../src/index.ts";
import type {
  AgentHost,
  AgentRuntime,
  AgentRuntimeOptions,
  InstanceReport,
  StorageScope,
  ToolContext,
} from "../src/index.ts";
import { heldStreams } from "../src/runtime.ts";

import {
  durableMemoryHost,
  eventually,
  fauxModels,
  follow,
  isRunEnd,
  memoryPlace,
  readUntil,
  runEnds,
} from "./helpers.ts";

const IDLE = 40;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Ports {
  readonly deleted: string[];
}

let release: () => void = () => undefined;
let holding: () => void = () => undefined;
const hold = defineTool({
  name: "hold",
  description: "Hold until released",
  tier: "read",
  parameters: z.object({}),
  async execute() {
    holding();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { text: "held" };
  },
});

const remove = defineTool({
  name: "remove",
  description: "Delete a note",
  tier: "write",
  parameters: z.object({ key: z.string() }),
  async execute({ key }, { ports }: ToolContext<Ports>) {
    ports.deleted.push(key);
    return { text: `deleted ${key}` };
  },
});

const agent = defineAgent<Ports>({
  kind: "notes",
  instructions: "You keep notes.",
  tools: [hold, remove],
  policy: { requiresApproval: ["write"] },
});

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function setup(
  options: {
    host?: AgentHost;
    place?: ReturnType<typeof memoryPlace>;
    reports?: InstanceReport[];
    settings?: AgentRuntimeOptions<Ports>["settings"];
  } = {},
) {
  const place = options.place ?? memoryPlace();
  const { faux, models, model } = fauxModels();
  const ports: Ports = { deleted: [] };
  const runtime = createAgentRuntime({
    agents: [agent],
    host: options.host ?? durableMemoryHost(place),
    models,
    ports,
    defaultModel: model,
    closeIdleAfterMs: IDLE,
    ...(options.reports && { onReport: (report: InstanceReport) => options.reports!.push(report) }),
    ...(options.settings && { settings: options.settings }),
  });
  runtimes.push(runtime);
  return { runtime, faux, models, model, ports, place };
}

describe("an idle instance", () => {
  it("closes, lets another runtime take its scope, and reopens through a handle the app holds", async () => {
    const { runtime, faux, models, model, place } = setup();
    faux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
    const alice = runtime.get(agent, "alice");
    const { id } = await alice.createSession();
    const session = alice.session(id);
    await session.submit({ text: "First", requestId: "1" });
    const first = await readUntil(session, isRunEnd);
    expect(runtime.inspect().open).toBe(1);

    await eventually(() => alice.state === "dormant");
    expect(runtime.inspect()).toEqual({ open: 0, instances: [] });
    expect(heldStreams(alice)).toEqual({ sessions: 0, events: 0, readers: 0 });
    expect(place.log).toEqual(["acquire notes/alice", "release notes/alice"]);

    // Another process (here a second runtime on the same storage and leases) can take the scope now.
    const other = createAgentRuntime({
      agents: [agent],
      host: durableMemoryHost(place),
      models,
      ports: { deleted: [] },
      defaultModel: model,
    });
    runtimes.push(other);
    expect(await other.get(agent, "alice").listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);
    await other.close();

    // The handles the app kept reopen the instance at their next call; `get` returns the same one.
    expect(runtime.get(agent, "alice")).toBe(alice);
    await session.submit({ text: "Second", requestId: "2" });
    expect(alice.state).toBe("open");
    // A reader whose cursor came from the closed log carries on from committed state: no reset, no
    // repeat, and the same view as reading the session whole.
    const back = await readUntil(session, isRunEnd, { from: first.at(-1)!.cursor });
    expect(back.some((item) => item.event.type === "stream:reset")).toBe(false);
    expect(
      back.filter((item) => item.event.type === "user").map((item) => item.event.type === "user" && item.event.text),
    ).toEqual(["Second"]);
    const whole = await readUntil(session, (_event, items) => runEnds(items) === 2);
    expect(foldEvents([...first, ...back].map((item) => item.event))).toEqual(
      foldEvents(whole.map((item) => item.event)),
    );
    expect(place.log).toEqual([
      "acquire notes/alice",
      "release notes/alice",
      "acquire notes/alice",
      "release notes/alice",
      "acquire notes/alice",
    ]);
  });

  it("stays open while a reader is attached, and closes once it leaves", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "r");
    const { id } = await instance.createSession();
    const reader = follow(instance.session(id));
    await eventually(() => runtime.inspect().instances[0]?.readers === 1);
    await pause(IDLE * 5);
    expect(instance.state).toBe("open");
    await reader.stop();
    await eventually(() => instance.state === "dormant");
  });

  it("stays open while a run is in progress, and closes once it ends", async () => {
    const { runtime, faux } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    const instance = runtime.get(agent, "w");
    const { id } = await instance.createSession();
    const running = new Promise<void>((resolve) => {
      holding = resolve;
    });
    await instance.session(id).submit({ text: "Hold", requestId: "1" });
    await running;
    await pause(IDLE * 5);
    expect(instance.state).toBe("open");
    release();
    await eventually(() => instance.state === "dormant");
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
  });

  it("is not kept open by a call parked for approval, and approve() reopens it and completes the run", async () => {
    const { runtime, faux, ports } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("remove", { key: "a" }, { id: "rm-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Removed."),
    ]);
    const instance = runtime.get(agent, "p");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "Delete a", requestId: "1" });
    await readUntil(session, (event) => event.type === "approval:request");
    await eventually(() => instance.state === "dormant");
    expect(ports.deleted).toEqual([]);

    expect(await session.approve([{ toolCallId: "rm-1", approved: true }])).toEqual([
      { toolCallId: "rm-1", outcome: "applied" },
    ]);
    const items = await readUntil(session, isRunEnd);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    expect(ports.deleted).toEqual(["a"]);
    const view = foldEvents(items.map((item) => item.event));
    expect(view.items.find((item) => item.kind === "tool")).toMatchObject({
      status: "ok",
      approval: { approved: true },
    });
  });

  it("reopens for a sleep due after it closed, so the sleeping work is not stranded", async () => {
    const { runtime, faux } = setup();
    // A transient provider error: pi-durable's generation sleeps its retry backoff (2 s by default).
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      fauxAssistantMessage("Recovered."),
    ]);
    const instance = runtime.get(agent, "s");
    const { id } = await instance.createSession();
    const submittedAt = Date.now();
    await instance.session(id).submit({ text: "Hi", requestId: "1" });
    await eventually(() => instance.state === "dormant" && faux.state.callCount === 1);
    // Closed while the retry sleeps; the runtime keeps it only to reopen it when the sleep is due.
    const [held] = runtime.inspect().instances;
    expect(held).toMatchObject({ scope: { kind: "notes", name: "s" }, state: "dormant" });
    expect(held?.wakeAt).toBeGreaterThan(submittedAt + IDLE);
    expect(runtime.inspect().open).toBe(0);

    await eventually(() => faux.state.callCount === 2, 10_000);
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    expect(items.find((item) => item.event.type === "assistant:end" && item.event.text === "Recovered.")).toBeDefined();
    // Done and idle again: nothing is held.
    await eventually(() => runtime.inspect().instances.length === 0);
  }, 15_000);

  it("leaves a due sleep to the writer that holds the scope by then, and holds nothing for it", async () => {
    const place = memoryPlace();
    const reports: InstanceReport[] = [];
    const { runtime, faux, models } = setup({ place, reports, settings: { retry: { baseDelayMs: 300 } } });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      fauxAssistantMessage("Recovered."),
    ]);
    const instance = runtime.get(agent, "t");
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Hi", requestId: "1" });
    await eventually(() => instance.state === "dormant" && runtime.inspect().instances[0]?.wakeAt !== undefined);

    // Another process takes the scope before the sleep is due, and runs the sleeping work itself.
    const other = createAgentRuntime({
      agents: [agent],
      host: durableMemoryHost(place),
      models,
      ports: { deleted: [] },
    });
    runtimes.push(other);
    await other.get(agent, "t").open();
    await eventually(() => reports.some((report) => report.source === "runtime" && report.kind === "reopen_failed"));
    expect(reports.find((report) => report.source === "runtime" && report.kind === "reopen_failed")).toMatchObject({
      error: expect.any(LeaseHeldError),
    });
    expect(instance.state).toBe("dormant");
    expect(runtime.inspect().instances).toEqual([]);
    await eventually(() => faux.state.callCount === 2);
  });

  it("tries a reopen for a due sleep again later when it fails", async () => {
    const place = memoryPlace();
    const reports: InstanceReport[] = [];
    const base = durableMemoryHost(place);
    let failing = false;
    const host: AgentHost = {
      ...base,
      async storage(scope, lease) {
        if (failing) {
          failing = false;
          throw new Error("storage down");
        }
        return base.storage(scope, lease);
      },
    };
    const { runtime, faux } = setup({ host, place, reports, settings: { retry: { baseDelayMs: 300 } } });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      fauxAssistantMessage("Recovered."),
    ]);
    const instance = runtime.get(agent, "u");
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Hi", requestId: "1" });
    await eventually(() => instance.state === "dormant" && runtime.inspect().instances[0]?.wakeAt !== undefined);
    const firstWake = runtime.inspect().instances[0]!.wakeAt!;
    failing = true;

    await eventually(() => reports.some((report) => report.source === "runtime" && report.kind === "reopen_failed"));
    expect(reports.find((report) => report.source === "runtime" && report.kind === "reopen_failed")).toMatchObject({
      error: expect.objectContaining({ message: "storage down" }),
    });
    // Still held, to try again a second or so later.
    const [held] = runtime.inspect().instances;
    expect(held).toMatchObject({ state: "dormant" });
    expect(held?.wakeAt).toBeGreaterThanOrEqual(firstWake + 1_000);

    await eventually(() => faux.state.callCount === 2, 10_000);
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
  }, 15_000);
});

describe("a call that comes while an idle close releases the lease", () => {
  it("waits, then reopens: no LeaseHeldError, never two writers, nothing lost", async () => {
    const place = memoryPlace();
    let releasing: () => void = () => undefined;
    const releaseStarted = new Promise<void>((resolve) => {
      releasing = resolve;
    });
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let first = true;
    const host = durableMemoryHost(place, {
      async releasing() {
        if (!first) return;
        first = false;
        releasing();
        await gate;
      },
    });
    const { runtime, faux } = setup({ host, place });
    faux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
    const instance = runtime.get(agent, "race");
    const { id } = await instance.createSession();
    const session = instance.session(id);
    await session.submit({ text: "First", requestId: "1" });
    await readUntil(session, isRunEnd);

    await releaseStarted;
    expect(instance.state).toBe("closing");
    // The Harness is closed and the lease not yet free: these calls must wait for it.
    const submitted = session.submit({ text: "Second", requestId: "2" });
    const listed = instance.listSessions();
    await pause(IDLE * 2);
    expect(instance.state).toBe("closing");
    expect(place.log).toEqual(["acquire notes/race"]);
    letGo();

    expect(await submitted).toEqual({ submissionId: expect.any(String) });
    expect(await listed).toEqual([{ id, createdAt: expect.any(Number) }]);
    const items = await readUntil(session, (_event, read) => runEnds(read) === 2);
    expect(
      items.filter((item) => item.event.type === "user").map((item) => item.event.type === "user" && item.event.text),
    ).toEqual(["First", "Second"]);
    expect(place.log.slice(0, 3)).toEqual(["acquire notes/race", "release notes/race", "acquire notes/race"]);
    // The storage refuses a second writer outright; it never had one.
    expect(Math.max(...place.writers.values())).toBeLessThanOrEqual(1);
  });
});

describe("closing for good", () => {
  it("keeps its meaning: an explicitly closed or runtime-closed instance never reopens", async () => {
    const { runtime } = setup();
    const instance = runtime.get(agent, "c");
    const { id } = await instance.createSession();
    await eventually(() => instance.state === "dormant");
    await instance.close();
    expect(instance.state).toBe("closed");
    await expect(instance.session(id).submit({ text: "x", requestId: "x" })).rejects.toBeInstanceOf(
      InstanceClosedError,
    );
    // A fresh handle for the scope opens again.
    const fresh = runtime.get(agent, "c");
    expect(fresh).not.toBe(instance);
    expect(await fresh.listSessions()).toEqual([{ id, createdAt: expect.any(Number) }]);

    // A handle closed only for idleness ends with the runtime.
    const other = runtime.get(agent, "d");
    await other.open();
    await eventually(() => other.state === "dormant");
    await runtime.close();
    expect(other.state).toBe("closed");
    await expect(other.listSessions()).rejects.toBeInstanceOf(InstanceClosedError);
  });
});

describe("with an alarm host", () => {
  it("arms the host with what is due before it closes, and resume() at the alarm reopens it", async () => {
    const place = memoryPlace();
    const arms: { scope: StorageScope; wake: Wake }[] = [];
    const host: AgentHost = {
      ...durableMemoryHost(place),
      wake: {
        kind: "alarm",
        async arm(scope, wake) {
          arms.push({ scope, wake });
        },
      },
    };
    const { runtime, faux } = setup({ host, place });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      fauxAssistantMessage("Recovered."),
    ]);
    const instance = runtime.get(agent, "a");
    const { id } = await instance.createSession();
    await instance.session(id).submit({ text: "Hi", requestId: "1" });
    await eventually(() => instance.state === "dormant");
    // The runtime leaves the wake-up to the host: it keeps nothing for it.
    expect(runtime.inspect().instances).toEqual([]);
    const last = arms.at(-1)!.wake;
    expect(last.active).toBe(false);
    expect(last.at).toBeGreaterThan(Date.now());

    // The host's alarm fires: it calls resume(), which reopens the instance and runs the due sleep.
    await pause(last.at! - Date.now() + 10);
    await instance.resume();
    expect(instance.state).toBe("open");
    const items = await readUntil(instance.session(id), isRunEnd);
    expect(items.at(-1)?.event).toEqual({ type: "run:end", reason: "done" });
    await eventually(() => instance.state === "dormant");
    expect(arms.at(-1)?.wake).toEqual({ active: false });
  }, 15_000);

  it("stays open and reports while the host cannot be armed for the close, and closes once it can", async () => {
    const place = memoryPlace();
    const reports: InstanceReport[] = [];
    let failing = false;
    const host: AgentHost = {
      ...durableMemoryHost(place),
      wake: {
        kind: "alarm",
        async arm() {
          if (failing) throw new Error("alarm unavailable");
        },
      },
    };
    const { runtime } = setup({ host, place, reports });
    const instance = runtime.get(agent, "f");
    await instance.open();
    failing = true;
    await pause(IDLE * 5);
    expect(instance.state).toBe("open");
    expect(place.log).toEqual(["acquire notes/f"]);
    expect(
      reports.filter((report) => report.source === "runtime" && report.kind === "arm_failed").length,
    ).toBeGreaterThan(1);

    failing = false;
    await eventually(() => instance.state === "dormant");
    expect(place.log).toEqual(["acquire notes/f", "release notes/f"]);
  });

  it("calls the close off for a call that comes while the host arms, and closes a whole idle time after it", async () => {
    const place = memoryPlace();
    let releasedAt = 0;
    let blocking = false;
    let arming: () => void = () => undefined;
    const armingStarted = new Promise<void>((resolve) => {
      arming = resolve;
    });
    let armed: () => void = () => undefined;
    const host: AgentHost = {
      ...durableMemoryHost(place, {
        async releasing() {
          releasedAt = Date.now();
        },
      }),
      wake: {
        kind: "alarm",
        async arm() {
          if (!blocking) return;
          blocking = false;
          arming();
          await new Promise<void>((resolve) => {
            armed = resolve;
          });
        },
      },
    };
    const { runtime } = setup({ host, place });
    const instance = runtime.get(agent, "g");
    await instance.open();
    blocking = true;
    await armingStarted;
    // The idle check is arming the host for the close when a call comes and goes.
    expect(instance.state).toBe("open");
    expect(await instance.listSessions()).toEqual([]);
    const calledAt = Date.now();
    armed();
    await pause(IDLE / 4);
    expect(instance.state).toBe("open");
    await eventually(() => instance.state === "dormant");
    expect(releasedAt - calledAt).toBeGreaterThanOrEqual(IDLE - 10);
    expect(place.log).toEqual(["acquire notes/g", "release notes/g"]);
  });
});
