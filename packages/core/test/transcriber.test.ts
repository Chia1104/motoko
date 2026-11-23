// The transcriber driven through its own interface. Each session is a real pi-durable conversation
// on MemoryStorage: a test commits what pi-durable would (entries, `pi.live`, the decisions, the
// inputs' settlements) through the Harness, and the transcriber reads history back through
// `historyOf`, as a session's stream does. Each test expects what the wire contract says a client
// is sent.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  LiveDoc,
  MemoryStorage,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  ConversationView,
  ConversationWindow,
  EntryId,
  EntryRecord,
  LiveState,
  SubmissionId,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentWireEvent } from "@chia1104/motoko-wire";

import { ApprovalsDoc } from "../src/engine/approvals.ts";
import { CallsDoc } from "../src/engine/calls.ts";
import { STEER_ENTRY, Transcriber } from "../src/engine/transcriber.ts";
import type { Endings, History, Position, Transcribed } from "../src/engine/transcriber.ts";
import { historyOf } from "../src/engine/watch.ts";

import { fauxModels } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

/** `remove` waits for an operator's decision; the other tools run at once. */
const info = (toolName: string) => ({
  label: toolName,
  tier: toolName === "remove" ? "write" : "read",
  gated: toolName === "remove",
});

// SAFETY: nothing here reads a task; any id stands for the run's.
const TASK = 1 as TaskId;

const usage = {
  input: 3,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 8,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};
/** A reply's usage as the wire carries it: the provider's counts and the total cost. */
const wireUsage = { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 };

const text = (value: string) => ({ type: "text" as const, text: value });
const thinking = (value: string) => ({ type: "thinking" as const, thinking: value });
const call = (id: string, name: string, args: Record<string, string> = {}) => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: args,
});
type Part = ReturnType<typeof text> | ReturnType<typeof thinking> | ReturnType<typeof call>;

/** A reply, stored as an entry or streaming in `pi.live`. */
const reply = (content: Part[], stopReason: AssistantMessage["stopReason"]) => ({
  role: "assistant" as const,
  content,
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage,
  stopReason,
  timestamp: 2,
});

const events = (transcribed: readonly Transcribed[]): AgentWireEvent[] => transcribed.map(({ event }) => event);

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close(context)));
});

type Write = (tx: Tx, live: Draft<LiveState>) => Promise<void>;

/** A conversation, what is committed to it, and the view an observer of it holds. */
async function session(window?: ConversationWindow) {
  const storage = new MemoryStorage();
  const { models, model } = fauxModels();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  harnesses.push(harness);
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model } },
    context,
  );
  const { id } = conversation;
  let view: ConversationView | undefined;
  const observation = await harness.observeConversation(
    id,
    {
      advance(change) {
        if (change.kind === "value") view = change.value;
      },
      end: () => undefined,
    },
    context,
    window,
  );
  const history = historyOf({ harness, storage, conversation });
  const current = () => view ?? observation.value;
  return {
    transcriber: () => new Transcriber(history, info),
    get view() {
      return current();
    },
    /** Commits `write`; returns the view before it and the one it leaves. */
    async commit(write: Write) {
      const was = current();
      await harness.commit(async (tx) => write(tx, await tx.doc(LiveDoc, id)), context);
      return { was, next: current() };
    },
    user: async (tx: Tx, words: string): Promise<EntryId> =>
      (await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: words, timestamp: 1 }] })).id,
    reply: async (tx: Tx, message: AssistantMessage): Promise<EntryId> =>
      (await tx.appendEntry(AssistantEntry, id, { model: [message] })).id,
    result: async (
      tx: Tx,
      callId: string,
      toolName: string,
      words: string,
      { isError = false, details, codes = [] }: { isError?: boolean; details?: JsonValue; codes?: string[] } = {},
    ): Promise<EntryId> =>
      (
        await tx.appendEntry(ToolResultEntry, id, {
          model: [
            {
              role: "toolResult",
              toolCallId: callId,
              toolName,
              content: [text(words)],
              isError,
              timestamp: 3,
              ...(details !== undefined && { details }),
            },
          ],
          data: { diagnostics: codes.map((code) => ({ severity: "error" as const, message: code, code })) },
        })
      ).id,
    /** The input that starts a run at `entry`, placed as the run takes it. */
    input: async (tx: Tx, entry: EntryId): Promise<SubmissionId> =>
      (await tx.createSubmission({ conversationId: id, type: "input", status: "placed", entry })).id,
    decide: async (tx: Tx, toolCallId: string, approved: boolean) => {
      (await tx.doc(ApprovalsDoc, id)).decisions[toolCallId] = { approved, at: 4 };
    },
    /** The record of a deferred call that task `taskId` started: it waits for a reply until 5000. */
    defer: async (tx: Tx, toolCallId: string, taskId: TaskId) => {
      (await tx.doc(CallsDoc, id)).calls[toolCallId] = { kind: "reply", taskId, token: "t", until: 5_000 };
    },
    /** The reply that reached a deferred call, recorded with it. */
    replied: async (tx: Tx, toolCallId: string) => {
      const record = (await tx.doc(CallsDoc, id)).calls[toolCallId];
      if (record?.kind === "reply") record.repliedAt = 4_000;
    },
  };
}

type Session = Awaited<ReturnType<typeof session>>;

/** The newest entry `view` reaches: where a stream that holds it stands. */
const newestOf = (view: ConversationView) => view.entries.at(-1)?.id ?? view.before ?? 0;

/** A client connected all along: a transcriber that takes up the session now and reads each commit. */
async function follow(session: Session) {
  const transcriber = session.transcriber();
  await transcriber.start(session.view);
  const sent: Transcribed[] = [];
  return {
    sent,
    /** Commits `write` and returns what the client is sent for it. */
    async commit(write: Write): Promise<AgentWireEvent[]> {
      const { was, next } = await session.commit(write);
      const transcribed = await transcriber.commit(was, next);
      sent.push(...transcribed);
      return events(transcribed);
    },
  };
}

/** What a client resuming at `from` (default: the session's start) is sent: history, then the in-flight state. */
async function catchUp(session: Session, from?: Position): Promise<Transcribed[]> {
  const transcriber = session.transcriber();
  if (from !== undefined) expect(await transcriber.restore(from)).toBe(true);
  const to = newestOf(session.view);
  const sent: Transcribed[] = [...transcriber.standing(session.view)];
  for await (const page of transcriber.replay(to)) sent.push(...page);
  sent.push(...(await transcriber.catchUp(to, session.view)));
  return sent;
}

/** A client resuming after each event of `sent` folds what it had and what it is sent into `sent`'s view. */
async function expectEveryResumeFolds(s: Session, sent: readonly Transcribed[]) {
  const view = foldEvents(events(sent));
  for (const [index, { event, position }] of sent.entries()) {
    const back = await catchUp(s, position);
    expect(foldEvents(events([...sent.slice(0, index + 1), ...back])), `resumed after ${event.type}`).toEqual(view);
  }
}

/** The stream id every streaming event names: one reply streams at a time. */
function streamIdOf(sent: readonly AgentWireEvent[]): string {
  const ids = new Set(
    sent.flatMap((event) =>
      event.type === "assistant:start" || event.type === "assistant:delta" ? [event.messageId] : [],
    ),
  );
  expect(ids.size).toBe(1);
  return [...ids][0]!;
}

describe("a client resuming mid-run", () => {
  it("is sent the rest of its run, then the reply streaming now, and folds the view of one connected all along", async () => {
    const s = await session();
    const live = await follow(s);
    let user: EntryId | undefined;
    await live.commit(async (tx, pi) => {
      user = await s.user(tx, "Build it");
      pi.run = { taskId: TASK, inputs: [await s.input(tx, user)], turns: 0 };
    });
    let asked: EntryId | undefined;
    await live.commit(async (tx, pi) => {
      asked = await s.reply(tx, reply([text("Building."), call("b1", "build")], "toolUse"));
      pi.tools = [{ callId: "b1", name: "build", status: "running", taskId: TASK }];
    });
    // The client goes away here, having folded the call's start.
    const cursor = live.sent.at(-1)!.position;
    expect(cursor).toEqual({ entry: asked, run: user });
    const seen = live.sent.length;

    let built: EntryId | undefined;
    await live.commit(async (tx, pi) => {
      built = await s.result(tx, "b1", "build", "built", { details: { ok: true } });
      pi.tools = [{ callId: "b1", name: "build", status: "done", taskId: TASK, entry: built }];
    });
    await live.commit(async (_tx, pi) => {
      delete pi.tools;
      pi.generation = {
        attempt: 1,
        message: reply([thinking("Checking"), text("It is bu"), call("d1", "deploy")], "pending"),
      };
    });

    const back = await catchUp(s, cursor);
    const stream = streamIdOf(events(back));
    expect(events(back)).toEqual([
      // It may still show inputs it saw queued, or a compaction going on: neither is.
      { type: "queue", items: [] },
      { type: "compaction:end" },
      { type: "tool:end", toolCallId: "b1", toolName: "build", status: "ok", details: { ok: true } },
      // The client may still show a retry wait from before it left: none is going on.
      { type: "retry:end" },
      { type: "assistant:start", messageId: stream },
      { type: "assistant:delta", messageId: stream, channel: "thinking", delta: "Checking" },
      { type: "assistant:delta", messageId: stream, channel: "text", delta: "It is bu" },
      { type: "tool:draft", toolCallId: "d1", toolName: "deploy" },
    ]);
    // Still in its run, past the result: the last cursor resumes there.
    expect(back.at(-1)!.position).toEqual({ entry: built, run: user });

    const view = foldEvents([...events(live.sent.slice(0, seen)), ...events(back)]);
    expect(view).toEqual(foldEvents(events(live.sent)));
    expect(view.status).toBe("running");
    expect(view.items).toMatchObject([
      { kind: "user", text: "Build it" },
      { kind: "assistant", text: "Building.", streaming: false, stopReason: "toolUse" },
      { kind: "tool", toolCallId: "b1", status: "ok", details: { ok: true } },
      { kind: "assistant", text: "It is bu", thinking: "Checking", streaming: true },
      { kind: "tool", toolCallId: "d1", status: "drafting" },
    ]);
  });

  it("is refused, with nothing read, at a place the storage does not hold", async () => {
    const s = await session();
    let user: EntryId | undefined;
    let answer: EntryId | undefined;
    await s.commit(async (tx) => {
      user = await s.user(tx, "Hi");
      answer = await s.reply(tx, reply([text("Hello.")], "stop"));
    });
    const transcriber = s.transcriber();
    expect(await transcriber.restore({ entry: 999_999, run: undefined })).toBe(false);
    // A run is named by the user entry that started it; a reply starts none.
    expect(await transcriber.restore({ entry: answer!, run: answer! })).toBe(false);
    expect(transcriber.position).toEqual({ entry: 0, run: undefined });
    expect(await transcriber.restore({ entry: answer!, run: user! })).toBe(true);
    expect(transcriber.position).toEqual({ entry: answer, run: user });
  });
});

describe("a run orphaned without an entry saying so", () => {
  it("ends as its input's settlement says, live and from history alike", async () => {
    const s = await session();
    const live = await follow(s);
    let first: EntryId | undefined;
    let input: SubmissionId | undefined;
    await live.commit(async (tx, pi) => {
      first = await s.user(tx, "First");
      input = await s.input(tx, first);
      pi.run = { taskId: TASK, inputs: [input], turns: 0 };
    });
    let asked: EntryId | undefined;
    await live.commit(async (tx, pi) => {
      asked = await s.reply(tx, reply([call("c1", "lookup", { key: "a" })], "toolUse"));
      pi.tools = [{ callId: "c1", name: "lookup", status: "running", taskId: TASK }];
    });
    // pi-durable found no task for the run: it settles the input with why, and says `orphaned`.
    await live.commit(async (tx, pi) => {
      delete pi.run;
      delete pi.tools;
      pi.runFailure = { taskId: TASK, inputs: [input!], reason: "orphaned", detail: "missing_task" };
      tx.settleSubmission(input!, { status: "unanswered", reason: "missing_task" });
    });
    let second: EntryId | undefined;
    let answer: EntryId | undefined;
    await live.commit(async (tx, pi) => {
      second = await s.user(tx, "Second");
      pi.run = { taskId: TASK, inputs: [await s.input(tx, second)], turns: 0 };
      delete pi.runFailure;
    });
    await live.commit(async (tx, pi) => {
      answer = await s.reply(tx, reply([text("Back.")], "stop"));
      delete pi.run;
    });

    const expected: AgentWireEvent[] = [
      { type: "run:start" },
      { type: "user", messageId: String(first), text: "First", at: 1 },
      { type: "assistant:end", messageId: String(asked), text: "", stopReason: "toolUse", usage: wireUsage, at: 2 },
      { type: "tool:start", toolCallId: "c1", toolName: "lookup", label: "lookup", tier: "read", args: { key: "a" } },
      // The call never got a result, and the run ended without an answer.
      { type: "tool:end", toolCallId: "c1", toolName: "lookup", status: "aborted" },
      { type: "run:end", reason: "error", code: "orphaned", error: "missing_task" },
      { type: "run:start" },
      { type: "user", messageId: String(second), text: "Second", at: 1 },
      { type: "assistant:end", messageId: String(answer), text: "Back.", stopReason: "stop", usage: wireUsage, at: 2 },
      { type: "run:end", reason: "done" },
    ];
    expect(events(live.sent)).toEqual(expected);
    // `pi.live` no longer says how the first run ended, and no entry does: its input's settlement does.
    expect(events(await catchUp(s))).toEqual(expected);
  });
});

describe("a run that no entry the stream reads starts", () => {
  /** A stream that opens once the input's entry is stored, before its run starts; `input` places that input. */
  async function opened() {
    const s = await session();
    let user: EntryId | undefined;
    await s.commit(async (tx) => {
      user = await s.user(tx, "Remove b");
    });
    return { s, live: await follow(s), input: (tx: Tx) => s.input(tx, user!) };
  }

  it("starts before what it streams, so a client resuming anywhere in it folds how it ended", async () => {
    const { s, live, input } = await opened();
    // The run's start and the first of its reply reach the stream in one commit.
    const started = await live.commit(async (tx, pi) => {
      pi.run = { taskId: TASK, inputs: [await input(tx)], turns: 0 };
      pi.generation = { attempt: 1, message: reply([text("Look")], "pending") };
    });
    const stream = streamIdOf(started);
    expect(started).toEqual([
      { type: "run:start" },
      { type: "assistant:start", messageId: stream },
      { type: "assistant:delta", messageId: stream, channel: "text", delta: "Look" },
    ]);
    expect(live.sent.map(({ position }) => position.run)).toEqual(["*", "*", "*"]);
    // The model request fails for good.
    await live.commit(async (tx, pi) => {
      await s.reply(tx, { ...reply([text("Look")], "error"), errorMessage: "overloaded" });
      delete pi.run;
      delete pi.generation;
    });

    expect(foldEvents(events(live.sent)).items).toMatchObject([
      { kind: "assistant", text: "Look", stopReason: "error" },
      { kind: "notice", reason: "error", code: "model_error" },
    ]);
    await expectEveryResumeFolds(s, live.sent);
  });

  it("starts before its first reply too, when the commit that starts it stores that reply", async () => {
    const { s, live, input } = await opened();
    let asked: EntryId | undefined;
    const started = await live.commit(async (tx, pi) => {
      pi.run = { taskId: TASK, inputs: [await input(tx)], turns: 0 };
      asked = await s.reply(tx, reply([call("c2", "remove", { key: "b" })], "toolUse"));
      pi.tools = [{ callId: "c2", name: "remove", status: "sleeping", taskId: TASK }];
    });
    expect(started).toEqual([
      { type: "run:start" },
      { type: "assistant:end", messageId: String(asked), text: "", stopReason: "toolUse", usage: wireUsage, at: 2 },
      { type: "tool:start", toolCallId: "c2", toolName: "remove", label: "remove", tier: "write", args: { key: "b" } },
      { type: "approval:request", toolCallId: "c2", toolName: "remove", tier: "write", args: { key: "b" } },
    ]);
    expect(live.sent.map(({ position }) => position.run)).toEqual(["*", "*", "*", "*"]);

    expect(foldEvents(events(live.sent))).toMatchObject({ status: "awaiting_approval", pendingApprovals: ["c2"] });
    await expectEveryResumeFolds(s, live.sent);
  });
});

describe("a call parked at the gate", () => {
  async function parked() {
    const s = await session();
    const live = await follow(s);
    let user: EntryId | undefined;
    let input: SubmissionId | undefined;
    await live.commit(async (tx, pi) => {
      user = await s.user(tx, "Delete a");
      input = await s.input(tx, user);
      pi.run = { taskId: TASK, inputs: [input], turns: 0 };
    });
    let asked: EntryId | undefined;
    const sent = await live.commit(async (tx, pi) => {
      asked = await s.reply(tx, reply([call("r1", "remove", { key: "a" })], "toolUse"));
      pi.tools = [{ callId: "r1", name: "remove", status: "sleeping", taskId: TASK }];
    });
    expect(sent).toEqual([
      { type: "assistant:end", messageId: String(asked), text: "", stopReason: "toolUse", usage: wireUsage, at: 2 },
      { type: "tool:start", toolCallId: "r1", toolName: "remove", label: "remove", tier: "write", args: { key: "a" } },
      { type: "approval:request", toolCallId: "r1", toolName: "remove", tier: "write", args: { key: "a" } },
    ]);
    return { s, live, input: input!, at: { entry: asked!, run: user! } };
  }

  it("ends aborted, undecided, when its run is aborted", async () => {
    const { s, live, input } = await parked();
    const sent = await live.commit(async (tx, pi) => {
      delete pi.run;
      delete pi.tools;
      pi.runFailure = { taskId: TASK, inputs: [input], reason: "aborted" };
      tx.settleSubmission(input, { status: "unanswered", reason: "aborted" });
    });
    expect(sent).toEqual([
      { type: "tool:end", toolCallId: "r1", toolName: "remove", status: "aborted" },
      { type: "run:end", reason: "aborted", code: "aborted" },
    ]);
    const view = foldEvents(events(live.sent));
    expect(view).toMatchObject({ status: "idle", pendingApprovals: [] });
    expect(view.items.slice(2)).toEqual([
      expect.objectContaining({ kind: "tool", toolCallId: "r1", status: "aborted" }),
      { kind: "notice", reason: "aborted", code: "aborted" },
    ]);
    expect(view.items[2]).not.toHaveProperty("approval");
    // A client arriving later is not asked any more, and folds the same view.
    const late = events(await catchUp(s));
    expect(late.some((event) => event.type === "approval:request")).toBe(false);
    expect(foldEvents(late)).toEqual(view);
  });

  it("runs once decided, and a client resuming at the question gets the decision with the result", async () => {
    const { s, live, at } = await parked();
    expect(
      await live.commit(async (tx, pi) => {
        await s.decide(tx, "r1", true);
        pi.tools = [{ callId: "r1", name: "remove", status: "running", taskId: TASK }];
      }),
    ).toEqual([{ type: "approval:resolved", toolCallId: "r1", approved: true }]);
    await live.commit(async (tx, pi) => {
      const done = await s.result(tx, "r1", "remove", "deleted a");
      pi.tools = [{ callId: "r1", name: "remove", status: "done", taskId: TASK, entry: done }];
    });
    const seen = live.sent.findIndex(({ event }) => event.type === "approval:request") + 1;
    const back = events(await catchUp(s, at));
    // The queue and compaction state it may hold, then the question, for a client that missed it, then its answer, then
    // the call's end.
    expect(back).toEqual([
      { type: "queue", items: [] },
      { type: "compaction:end" },
      { type: "approval:request", toolCallId: "r1", toolName: "remove", tier: "write", args: { key: "a" } },
      { type: "approval:resolved", toolCallId: "r1", approved: true },
      { type: "tool:end", toolCallId: "r1", toolName: "remove", status: "ok" },
      { type: "retry:end" },
    ]);
    expect(foldEvents([...events(live.sent.slice(0, seen)), ...back])).toEqual(foldEvents(events(live.sent)));
  });
});

describe("a deferred call woken from its wait", () => {
  // SAFETY: nothing here reads a task; the call's record and its slot name the same one.
  const CALL = 2 as TaskId;
  const slot = (status: "running" | "sleeping") => ({ callId: "a1", name: "ask", status, taskId: CALL });
  const runs: Write = async (_tx, pi) => {
    pi.tools = [slot("running")];
  };

  it.each<[string, (s: Session) => Write[]]>([
    // The reply is recorded in the commit that wakes the call, which sleeps until it runs again.
    ["a reply", (s) => [async (tx) => s.replied(tx, "a1"), runs]],
    // The deadline wakes it with nothing recorded.
    ["its deadline", () => [runs]],
  ])("runs again until it ends, for a client resuming anywhere too, once %s woke it", async (_by, wake) => {
    const s = await session();
    const live = await follow(s);
    await live.commit(async (tx, pi) => {
      pi.run = { taskId: TASK, inputs: [await s.input(tx, await s.user(tx, "Ask Bob"))], turns: 0 };
    });
    await live.commit(async (tx, pi) => {
      await s.reply(tx, reply([call("a1", "ask")], "toolUse"));
      await s.defer(tx, "a1", CALL);
      pi.tools = [slot("running")];
    });
    const parked = await live.commit(async (_tx, pi) => {
      pi.tools = [slot("sleeping")];
    });
    expect(parked).toEqual([{ type: "reply:wait", toolCallId: "a1", until: 5_000 }]);

    for (const write of wake(s)) {
      await live.commit(write);
      const view = foldEvents(events(live.sent));
      expect(view.items.find((item) => item.kind === "tool")).toMatchObject({ status: "running" });
      // A client that resumes at the wait, or anywhere else, has the call running too.
      await expectEveryResumeFolds(s, live.sent);
    }
  });
});

describe("a call cut off before its result", () => {
  it("ends aborted, and so does its run when nothing follows it, live and from history alike", async () => {
    const s = await session();
    const live = await follow(s);
    await live.commit(async (tx, pi) => {
      pi.run = { taskId: TASK, inputs: [await s.input(tx, await s.user(tx, "Wait"))], turns: 0 };
    });
    await live.commit(async (tx, pi) => {
      await s.reply(tx, reply([call("w1", "wait")], "toolUse"));
      pi.tools = [{ callId: "w1", name: "wait", status: "running", taskId: TASK }];
    });
    // pi-durable's result for a call a restart cut off: an error, marked unfinished.
    expect(
      await live.commit(async (tx, pi) => {
        const cut = await s.result(tx, "w1", "wait", "The call was interrupted.", {
          isError: true,
          codes: ["interrupted"],
        });
        pi.tools = [{ callId: "w1", name: "wait", status: "done", taskId: TASK, entry: cut }];
      }),
    ).toEqual([{ type: "tool:end", toolCallId: "w1", toolName: "wait", status: "aborted" }]);
    expect(
      await live.commit(async (_tx, pi) => {
        delete pi.run;
        delete pi.tools;
      }),
    ).toEqual([{ type: "run:end", reason: "aborted", code: "aborted" }]);
    expect(events(await catchUp(s))).toEqual(events(live.sent));
  });
});

describe("a retry wait", () => {
  it("goes out while the model request waits, ends when it is sent again, and a resuming client hears which", async () => {
    const s = await session();
    const live = await follow(s);
    let user: EntryId | undefined;
    await live.commit(async (tx, pi) => {
      user = await s.user(tx, "Hi");
      pi.run = { taskId: TASK, inputs: [await s.input(tx, user)], turns: 0 };
      pi.generation = { attempt: 1 };
    });
    const at: Position = { entry: user!, run: user! };
    const waiting = { type: "retry:wait", error: "overloaded", at: 5_000 } as const;

    expect(
      await live.commit(async (_tx, pi) => {
        pi.generation = { attempt: 1, retry: { at: 5_000, error: "overloaded" } };
      }),
    ).toEqual([waiting]);
    const noQueue = { type: "queue", items: [] } as const;
    const noCompaction = { type: "compaction:end" } as const;
    expect(events(await catchUp(s, at))).toEqual([noQueue, noCompaction, waiting]);

    const sent = await live.commit(async (_tx, pi) => {
      pi.generation = { attempt: 2, message: reply([text("Hel")], "pending") };
    });
    const stream = streamIdOf(sent);
    const resent = [
      { type: "retry:end" },
      { type: "assistant:start", messageId: stream },
      { type: "assistant:delta", messageId: stream, channel: "text", delta: "Hel" },
    ];
    expect(sent).toEqual(resent);
    expect(events(await catchUp(s, at))).toEqual([noQueue, noCompaction, ...resent]);

    let answer: EntryId | undefined;
    expect(
      await live.commit(async (tx, pi) => {
        answer = await s.reply(tx, reply([text("Hello.")], "stop"));
        delete pi.run;
        delete pi.generation;
      }),
    ).toEqual([
      { type: "assistant:end", messageId: String(answer), text: "Hello.", stopReason: "stop", usage: wireUsage, at: 2 },
      { type: "run:end", reason: "done" },
    ]);
    const view = foldEvents(events(live.sent));
    expect(view).not.toHaveProperty("retrying");
    expect(view.items).toMatchObject([
      { kind: "user", text: "Hi" },
      { kind: "assistant", text: "Hello.", streaming: false },
    ]);
  });

  it("ends before its run does when the run gives up", async () => {
    const s = await session();
    const live = await follow(s);
    let input: SubmissionId | undefined;
    await live.commit(async (tx, pi) => {
      input = await s.input(tx, await s.user(tx, "Hi"));
      pi.run = { taskId: TASK, inputs: [input], turns: 0 };
      pi.generation = { attempt: 1, retry: { at: 5_000, error: "overloaded" } };
    });
    expect(
      await live.commit(async (tx, pi) => {
        delete pi.run;
        delete pi.generation;
        pi.runFailure = { taskId: TASK, inputs: [input!], reason: "model_error", detail: "overloaded" };
        tx.settleSubmission(input!, { status: "unanswered", reason: "model_error", detail: "overloaded" });
      }),
    ).toEqual([{ type: "retry:end" }, { type: "run:end", reason: "error", code: "model_error", error: "overloaded" }]);
  });
});

describe("drafted calls", () => {
  it("go out once each as the reply streams, and the stored reply's calls take their place", async () => {
    const s = await session();
    const live = await follow(s);
    let first = await live.commit(async (tx, pi) => {
      pi.run = { taskId: TASK, inputs: [await s.input(tx, await s.user(tx, "Look up a, delete b"))], turns: 0 };
      // The second call has no id yet: nothing can name it.
      pi.generation = {
        attempt: 1,
        message: reply([text("Let me"), call("c1", "lookup"), call("", "remove")], "pending"),
      };
    });
    const stream = streamIdOf(first);
    first = first.slice(2);
    expect(first).toEqual([
      { type: "assistant:start", messageId: stream },
      { type: "assistant:delta", messageId: stream, channel: "text", delta: "Let me" },
      { type: "tool:draft", toolCallId: "c1", toolName: "lookup" },
    ]);
    expect(
      await live.commit(async (_tx, pi) => {
        pi.generation = {
          attempt: 1,
          message: reply([text("Let me check"), call("c1", "lookup", { key: "a" }), call("c2", "remove")], "pending"),
        };
      }),
    ).toEqual([
      { type: "assistant:delta", messageId: stream, channel: "text", delta: " check" },
      { type: "tool:draft", toolCallId: "c2", toolName: "remove" },
    ]);
    let stored: EntryId | undefined;
    expect(
      await live.commit(async (tx, pi) => {
        stored = await s.reply(
          tx,
          reply(
            [text("Let me check"), call("c1", "lookup", { key: "a" }), call("c2", "remove", { key: "b" })],
            "toolUse",
          ),
        );
        delete pi.generation;
        pi.tools = [
          { callId: "c1", name: "lookup", status: "running", taskId: TASK },
          { callId: "c2", name: "remove", status: "sleeping", taskId: TASK },
        ];
      }),
    ).toEqual([
      {
        type: "assistant:end",
        messageId: String(stored),
        text: "Let me check",
        stopReason: "toolUse",
        usage: wireUsage,
        at: 2,
      },
      { type: "tool:start", toolCallId: "c1", toolName: "lookup", label: "lookup", tier: "read", args: { key: "a" } },
      { type: "tool:start", toolCallId: "c2", toolName: "remove", label: "remove", tier: "write", args: { key: "b" } },
      { type: "approval:request", toolCallId: "c2", toolName: "remove", tier: "write", args: { key: "b" } },
    ]);
    const view = foldEvents(events(live.sent));
    expect(view).toMatchObject({ status: "awaiting_approval", pendingApprovals: ["c2"] });
    expect(view.items).toMatchObject([
      { kind: "user" },
      { kind: "assistant", messageId: String(stored), text: "Let me check", streaming: false },
      { kind: "tool", toolCallId: "c1", status: "running", args: { key: "a" } },
      { kind: "tool", toolCallId: "c2", status: "awaiting_approval", args: { key: "b" } },
    ]);
  });
});

describe("a stream that opens mid-run", () => {
  it("is sent only what follows the view it opened at", async () => {
    const s = await session();
    let user: EntryId | undefined;
    await s.commit(async (tx, pi) => {
      user = await s.user(tx, "Find a");
      pi.run = { taskId: TASK, inputs: [await s.input(tx, user)], turns: 0 };
      await s.reply(tx, reply([call("c1", "lookup", { key: "a" })], "toolUse"));
      pi.tools = [{ callId: "c1", name: "lookup", status: "running", taskId: TASK, output: "step 1\n" }];
    });
    const live = await follow(s);
    expect(
      await live.commit(async (_tx, pi) => {
        pi.tools = [{ callId: "c1", name: "lookup", status: "running", taskId: TASK, output: "step 1\nstep 2\n" }];
      }),
    ).toEqual([{ type: "tool:update", toolCallId: "c1", output: "step 1\nstep 2\n" }]);
    expect(
      await live.commit(async (tx, pi) => {
        const found = await s.result(tx, "c1", "lookup", "a is here");
        pi.tools = [{ callId: "c1", name: "lookup", status: "done", taskId: TASK, entry: found }];
      }),
    ).toEqual([{ type: "tool:end", toolCallId: "c1", toolName: "lookup", status: "ok" }]);
    const started = await live.commit(async (_tx, pi) => {
      delete pi.tools;
      pi.generation = { attempt: 1, message: reply([text("Fou")], "pending") };
    });
    const stream = streamIdOf(started);

    // A second stream opens while the reply streams: it does not start the reply again.
    const later = await follow(s);
    let answer: EntryId | undefined;
    const delta = { type: "assistant:delta", messageId: stream, channel: "text", delta: "nd it" };
    expect(
      await later.commit(async (_tx, pi) => {
        pi.generation = { attempt: 1, message: reply([text("Found it")], "pending") };
      }),
    ).toEqual([delta]);
    expect(
      await later.commit(async (tx, pi) => {
        answer = await s.reply(tx, reply([text("Found it.")], "stop"));
        delete pi.run;
        delete pi.generation;
      }),
    ).toEqual([
      {
        type: "assistant:end",
        messageId: String(answer),
        text: "Found it.",
        stopReason: "stop",
        usage: wireUsage,
        at: 2,
      },
      { type: "run:end", reason: "done" },
    ]);
    expect(later.sent.map(({ position }) => position.run)).toEqual([user, user, undefined]);
  });
});

describe("a commit that appends more than the observer's window holds", () => {
  it("is read whole: the entries the window skipped come from history", async () => {
    const s = await session({ min: 1, max: 2 });
    const live = await follow(s);
    const ids: EntryId[] = [];
    await live.commit(async (tx, pi) => {
      const user = await s.user(tx, "Look up a");
      pi.run = { taskId: TASK, inputs: [await s.input(tx, user)], turns: 0 };
      ids.push(user);
      ids.push(await s.reply(tx, reply([call("c1", "lookup", { key: "a" })], "toolUse")));
      ids.push(await s.result(tx, "c1", "lookup", "a is here"));
      ids.push(await s.reply(tx, reply([text("Found.")], "stop")));
      delete pi.run;
    });
    expect(s.view.entries.length).toBeLessThan(ids.length);
    const [asking, asked, , answered] = ids.map(String);
    expect(events(live.sent)).toEqual([
      { type: "run:start" },
      { type: "user", messageId: asking, text: "Look up a", at: 1 },
      { type: "assistant:end", messageId: asked, text: "", stopReason: "toolUse", usage: wireUsage, at: 2 },
      { type: "tool:start", toolCallId: "c1", toolName: "lookup", label: "lookup", tier: "read", args: { key: "a" } },
      { type: "tool:end", toolCallId: "c1", toolName: "lookup", status: "ok" },
      { type: "assistant:end", messageId: answered, text: "Found.", stopReason: "stop", usage: wireUsage, at: 2 },
      { type: "run:end", reason: "done" },
    ]);
  });
});

describe("inputs placed by a generation", () => {
  // SAFETY: stored history as pi-durable writes it, with the task that placed each entry; ids are pi's brands.
  const stored = (
    id: number,
    kind: string,
    message: EntryRecord["model"],
    byTaskId?: number,
    data?: EntryRecord["data"],
  ): EntryRecord => ({
    id: id as EntryId,
    conversationId: 1 as ConversationId,
    kind,
    model: message,
    ...(byTaskId !== undefined && { byTaskId: byTaskId as TaskId }),
    ...(data !== undefined && { data }),
  });
  const input = (id: number, kind: string, words: string, byTaskId?: number) =>
    stored(id, kind, [{ role: "user", content: words, timestamp: id }], byTaskId);
  const round = (id: number, byTaskId: number) =>
    stored(id, AssistantEntry.kind, [reply([call(`c${id}`, "build")], "toolUse")], byTaskId);
  const result = (id: number, callId: string) =>
    stored(
      id,
      ToolResultEntry.kind,
      [
        {
          role: "toolResult",
          toolCallId: callId,
          toolName: "build",
          content: [text("built")],
          isError: false,
          timestamp: 3,
        },
      ],
      undefined,
      { diagnostics: [] },
    );

  /** History as storage holds it: these entries, and how the runs that did not answer ended, by their inputs. */
  function history(entries: readonly EntryRecord[], endings: Endings): History {
    return {
      async *pages(min, max) {
        yield entries.filter((entry) => entry.id >= (min ?? 1) && entry.id <= max);
      },
      entry: async (id) => entries.find((entry) => entry.id === id),
      runStart: async () => undefined,
      decisions: async () => ({}),
      calls: async () => ({}),
      endings: async () => endings,
    };
  }

  async function replayed(entries: readonly EntryRecord[], endings: Endings): Promise<AgentWireEvent[]> {
    const transcriber = new Transcriber(history(entries, endings), info);
    const sent: Transcribed[] = [];
    for await (const page of transcriber.replay(entries.at(-1)!.id)) sent.push(...page);
    return events(sent);
  }

  const turnLimit = { reason: "turn_limit", detail: "1 turn" };

  it("start a run when a failed run hands them on, though the next run fails the same way", async () => {
    // Run 1 (generation 11) fails at its round's boundary and hands the input waiting for its answer to the next run,
    // which fails the same way: two runs, as the live stream showed.
    const entries = [
      input(1, UserEntry.kind, "First"),
      round(2, 11),
      result(3, "c2"),
      input(4, UserEntry.kind, "Then", 11),
      round(5, 21),
      result(6, "c5"),
    ];
    const sent = await replayed(
      entries,
      new Map([
        [1, turnLimit],
        [4, turnLimit],
      ]),
    );
    expect(sent.filter((event) => event.type === "run:start")).toHaveLength(2);
    expect(sent).toContainEqual({ type: "run:end", reason: "error", code: "turn_limit", error: "1 turn" });
    expect(sent.find((event) => event.type === "user" && event.text === "Then")).not.toHaveProperty("steer");
  });

  it("join the run going on when submitted as a steer and placed after its round, also in a run that then fails", async () => {
    const entries = [
      input(1, UserEntry.kind, "First"),
      round(2, 11),
      result(3, "c2"),
      input(4, STEER_ENTRY, "This way", 11),
      round(5, 12),
      result(6, "c5"),
    ];
    const sent = await replayed(
      entries,
      new Map([
        [1, turnLimit],
        [4, turnLimit],
      ]),
    );
    expect(sent.filter((event) => event.type === "run:start")).toHaveLength(1);
    expect(sent.find((event) => event.type === "user" && event.text === "This way")).toMatchObject({ steer: true });
  });
});
