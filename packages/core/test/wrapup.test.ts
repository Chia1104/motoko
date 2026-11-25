// Each test expects what the `afterRun` bullet of the README's "App extensions" says.

import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTask, GenerationTask, hook, hookTask } from "@earendil-works/pi-durable";
import type { Extension, Task } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { foldEvents } from "@chia1104/motoko-wire";
import type { StreamItem } from "@chia1104/motoko-wire";

import { createAgentRuntime, defineAgent, SessionBusyError } from "../src/index.ts";
import type { AgentHost, AgentRuntime } from "../src/index.ts";

import {
  committedOnly,
  durableMemoryHost,
  expectEveryResumeFolds,
  fauxModels,
  follow,
  memoryHost,
  memoryPlace,
  readUntil,
  runEnds,
} from "./helpers.ts";

const desk = defineAgent({ kind: "desk", instructions: "You run the desk.", tools: [] });

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function start(options: { host?: AgentHost; extensions?: readonly Extension[]; answers: readonly string[] }) {
  const { faux, models, model } = fauxModels();
  faux.setResponses(options.answers.map((answer) => fauxAssistantMessage(answer)));
  const runtime = createAgentRuntime({
    agents: [desk],
    host: options.host ?? memoryHost(),
    models,
    ports: {},
    defaultModel: model,
    extensionsFor: () => (options.extensions ?? []).map((extension) => ({ extension })),
  });
  runtimes.push(runtime);
  return { runtime, instance: runtime.get(desk, "alice") };
}

const done = { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };

const titles = <S extends { phase: string }>(task: Task<null, S, null, object>) =>
  defineExtension({
    name: "titles",
    tasks: [task],
    hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [hookTask(task, null)] }) })],
  });

function heldTitles() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const task = defineTask<null, { phase: "name" }, null>({
    name: "app.title",
    version: 1,
    initial: () => ({ phase: "name" }),
    phases: {
      async name(_task, runtime, context) {
        await released;
        await runtime.commit(async () => done, context);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(async () => done, context);
    },
  });
  return { extension: titles(task), release };
}

const NAMING_MS = 300;

const sleepingTitles = titles(
  defineTask<null, { phase: "name" } | { phase: "named" }, null>({
    name: "app.title",
    version: 1,
    initial: () => ({ phase: "name" }),
    phases: {
      async name(_task, runtime, context) {
        await runtime.sleepUntil(runtime.now() + NAMING_MS, { phase: "named" }, context);
      },
      async named(_task, runtime, context) {
        await runtime.commit(async () => done, context);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(async () => done, context);
    },
  }),
);

const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));

const phases = (items: readonly StreamItem[]) =>
  items.map((item) => item.event.type).filter((type) => type.startsWith("run:") || type.startsWith("wrapup:"));

const wrapupEnds = (items: readonly StreamItem[]) => items.filter((item) => item.event.type === "wrapup:end").length;

describe("a run's wrap-up", () => {
  it("goes out after its run's end and ends before the next run's start, folding the same from every cursor", async () => {
    const held = heldTitles();
    const { instance } = start({ extensions: [held.extension], answers: ["Hi.", "Later."] });
    const session = instance.session((await instance.createSession()).id);
    const reader = follow(session);
    try {
      await session.submit({ text: "Hi", requestId: "1" });
      await session.submit({ text: "Later", requestId: "2" });
      const wrapping = await reader.until(
        (items) => fold(items).wrappingUp === true && fold(items).queued?.length === 1,
      );
      expect(fold(wrapping)).toMatchObject({ status: "idle", wrappingUp: true, queued: [{ text: "Later" }] });
    } finally {
      held.release();
    }
    const live = await reader.until((items) => wrapupEnds(items) === 2);
    expect(phases(live)).toEqual([
      "run:start",
      "run:end",
      "wrapup:start",
      "wrapup:end",
      "run:start",
      "run:end",
      "wrapup:start",
      "wrapup:end",
    ]);
    const view = fold(live);
    expect(view).not.toHaveProperty("wrappingUp");
    expect(view.items.filter((item) => item.kind === "assistant")).toMatchObject([{ text: "Hi." }, { text: "Later." }]);

    const replayed = await readUntil(session, (_event, items) => items.at(-1)!.cursor === live.at(-1)!.cursor);
    expect(phases(replayed)).toEqual(["run:start", "run:end", "run:start", "run:end"]);
    expect(fold(replayed)).toEqual(view);
    await expectEveryResumeFolds(session, live);
    await reader.stop();
  });

  it("refuses an input that rejects and holds one that queues while it goes on, also after a restart", async () => {
    const place = memoryPlace();
    const first = start({ host: durableMemoryHost(place), extensions: [sleepingTitles], answers: ["Hi."] });
    const id = (await first.instance.createSession()).id;
    const session = first.instance.session(id);
    const reader = follow(session);
    await session.submit({ text: "Hi", requestId: "1" });
    await reader.until((items) => runEnds(items) === 1);

    await expect(session.submit({ text: "Now", requestId: "2", whenBusy: "reject" })).rejects.toBeInstanceOf(
      SessionBusyError,
    );
    expect(fold(reader.items)).toMatchObject({ status: "idle", wrappingUp: true });
    await session.submit({ text: "Later", requestId: "3" });
    const before = await reader.until((items) => fold(items).queued?.length === 1);
    expect(fold(before)).toMatchObject({ wrappingUp: true, queued: [{ text: "Later" }] });

    await first.runtime.close();
    await reader.stop();
    const second = start({ host: durableMemoryHost(place), extensions: [sleepingTitles], answers: ["Later."] });
    const reopened = second.instance.session(id);
    const resumed = follow(reopened, before.at(-1)!.cursor);
    const after = await resumed.until((items) => wrapupEnds(items) === 2);
    expect(phases(after)).toEqual(["wrapup:start", "wrapup:end", "run:start", "run:end", "wrapup:start", "wrapup:end"]);
    const live = [...before, ...after];
    const view = fold(live);
    expect(view).not.toHaveProperty("wrappingUp");
    expect(view).not.toHaveProperty("queued");
    expect(view.items.filter((item) => item.kind === "assistant")).toMatchObject([{ text: "Hi." }, { text: "Later." }]);
    await expectEveryResumeFolds(reopened, live);
    await resumed.stop();
  });

  it("goes out for no agent without an `afterRun` hook, but for one end a reader resumed between runs may get", async () => {
    const { instance } = start({ answers: ["Hi.", "Again."] });
    const session = instance.session((await instance.createSession()).id);
    const reader = follow(session);
    await session.submit({ text: "Hi", requestId: "1" });
    await session.submit({ text: "Again", requestId: "2" });
    const live = await reader.until((items) => runEnds(items) === 2);
    expect(phases(live)).toEqual(["run:start", "run:end", "run:start", "run:end"]);

    const between = live.find((item) => item.event.type === "run:end")!.cursor;
    const back = await readUntil(session, (_event, items) => items.at(-1)!.cursor === live.at(-1)!.cursor, {
      from: committedOnly(between),
    });
    expect(phases(back)).toEqual(["wrapup:end", "run:start", "run:end"]);
    await reader.stop();
  });
});
