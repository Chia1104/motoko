// Each test expects what the README's "App extensions" says under "Stable names", and what "The runtime" says of
// `task_blocked`.

import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTask, GenerationTask, hook, hookTask } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { foldEvents } from "@chia1104/motoko-wire";
import type { StreamItem } from "@chia1104/motoko-wire";

import { createAgentRuntime, defineAgent, SessionBusyError } from "../src/index.ts";
import type { AgentRuntime, AppExtension, InstanceReport } from "../src/index.ts";

import { durableMemoryHost, eventually, fauxModels, isRunEnd, memoryPlace, readUntil, runEnds } from "./helpers.ts";
import type { MemoryPlace } from "./helpers.ts";

const desk = defineAgent({ kind: "desk", instructions: "You run the desk.", tools: [] });

const NAP_MS = 150;

type TitleState = { phase: "nap" } | { phase: "name" };
const done = { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };

let slept!: () => void;
let napping = new Promise<void>((resolve) => (slept = resolve));

const titleTask = (version: number, migrate?: () => never) =>
  defineTask<null, TitleState, null>({
    name: "app.title",
    version,
    ...(migrate !== undefined && { migrate }),
    initial: () => ({ phase: "nap" }),
    phases: {
      async nap(_task, runtime, context) {
        await runtime.commit(
          async () => ({ status: "sleeping", checkpoint: { phase: "name" }, until: runtime.now() + NAP_MS }),
          context,
        );
        slept();
      },
      async name(_task, runtime, context) {
        await runtime.commit(async () => done, context);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(async () => done, context);
    },
  });

const title = titleTask(1);

const titlesWith = (task: typeof title): AppExtension => ({
  extension: defineExtension({
    name: "titles",
    tasks: [task],
    hooks: [hook(GenerationTask, { afterRun: () => ({ tasks: [hookTask(task, null)] }) })],
  }),
});

const titles = titlesWith(title);

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  napping = new Promise<void>((resolve) => (slept = resolve));
});

function start(place: MemoryPlace, models: ReturnType<typeof fauxModels>, extensions: readonly AppExtension[]) {
  const reports: InstanceReport[] = [];
  const runtime = createAgentRuntime({
    agents: [desk],
    host: durableMemoryHost(place),
    models: models.models,
    ports: {},
    defaultModel: models.model,
    extensionsFor: () => extensions,
    onReport: (report) => reports.push(report),
  });
  runtimes.push(runtime);
  return { runtime, instance: runtime.get(desk, "alice"), reports };
}

const blockedOf = (reports: readonly InstanceReport[]) =>
  reports.filter((report) => report.source === "runtime" && report.kind === "task_blocked");
const fold = (items: readonly StreamItem[]) => foldEvents(items.map((item) => item.event));

async function sleepingTitle() {
  const place = memoryPlace();
  const models = fauxModels();
  const first = start(place, models, [titles]);
  const { id: sessionId } = await first.instance.createSession();
  models.faux.setResponses([fauxAssistantMessage("Hi.")]);
  const session = first.instance.session(sessionId);
  await session.submit({ text: "Hi", requestId: "1" });
  await readUntil(session, isRunEnd);
  await napping;
  await first.runtime.close();
  const blocked = (reason: string) => ({
    source: "runtime",
    scope: { kind: "desk", name: "alice" },
    kind: "task_blocked",
    sessionId,
    taskKind: "app.title",
    reason,
  });
  return { place, models, sessionId, blocked };
}

describe("a task whose extension an open leaves out", () => {
  it("is reported as the instance opens, keeps its session busy, and runs once its extension is back", async () => {
    const { place, models, sessionId, blocked } = await sleepingTitle();

    const without = start(place, models, []);
    const session = without.instance.session(sessionId);
    await without.instance.open();
    await eventually(() => blockedOf(without.reports).length > 0);
    expect(blockedOf(without.reports)).toEqual([blocked("missing_task")]);
    await expect(session.submit({ text: "Now", requestId: "2", whenBusy: "reject" })).rejects.toBeInstanceOf(
      SessionBusyError,
    );
    await session.submit({ text: "Later", requestId: "3" });
    await new Promise((resolve) => setTimeout(resolve, NAP_MS * 2));
    const waiting = await readUntil(session, (_event, read) => fold(read).queued?.length === 1);
    expect(fold(waiting)).toMatchObject({ status: "idle", queued: [{ text: "Later" }] });
    models.faux.setResponses([fauxAssistantMessage("Other.")]);
    const other = without.instance.session((await without.instance.createSession()).id);
    await other.submit({ text: "Other", requestId: "1" });
    await readUntil(other, isRunEnd);
    expect(blockedOf(without.reports)).toEqual([blocked("missing_task")]);
    await without.runtime.close();

    const again = start(place, models, []);
    await again.instance.open();
    await eventually(() => blockedOf(again.reports).length > 0);
    expect(blockedOf(again.reports)).toEqual([blocked("missing_task")]);
    await again.runtime.close();

    models.faux.setResponses([fauxAssistantMessage("Later.")]);
    const back = start(place, models, [titles]);
    const view = fold(await readUntil(back.instance.session(sessionId), (_event, read) => runEnds(read) === 2));
    expect(view.items.filter((item) => item.kind === "assistant")).toMatchObject([{ text: "Hi." }, { text: "Later." }]);
    expect(blockedOf(back.reports)).toEqual([]);
  });

  it("ends with the session's abort, which frees the session", async () => {
    const { place, models, sessionId } = await sleepingTitle();
    const without = start(place, models, []);
    const session = without.instance.session(sessionId);
    await without.instance.open();
    await eventually(() => blockedOf(without.reports).length > 0);

    await session.abort();
    models.faux.setResponses([fauxAssistantMessage("Again.")]);
    await session.submit({ text: "Again", requestId: "2", whenBusy: "reject" });
    const view = fold(await readUntil(session, (_event, read) => runEnds(read) === 2));
    expect(view.items.filter((item) => item.kind === "assistant")).toMatchObject([{ text: "Hi." }, { text: "Again." }]);
    expect(blockedOf(without.reports)).toHaveLength(1);
  });

  it("is reported when it becomes blocked while the instance is open: its migration fails as it wakes", async () => {
    const { place, models, blocked } = await sleepingTitle();
    const newer = titleTask(2, () => {
      throw new Error("cannot read a version 1 title");
    });
    const opened = start(place, models, [titlesWith(newer)]);
    await opened.instance.open();
    await eventually(() => blockedOf(opened.reports).length > 0);
    expect(blockedOf(opened.reports)).toEqual([blocked("migration_failed")]);
    expect(opened.reports).toContainEqual(
      expect.objectContaining({ source: "pi", report: expect.objectContaining({ kind: "migration_failed" }) }),
    );
  });
});
