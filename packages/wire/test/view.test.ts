import { describe, expect, it } from "vite-plus/test";

import {
  agentWireEventSchema,
  applyEvent,
  cursorSchema,
  decodeCursor,
  delegateOf,
  emptySessionView,
  encodeCursor,
  foldEvents,
} from "../src/index.ts";
import type { AgentSessionView, AgentWireEvent, ToolItem } from "../src/index.ts";

const live: AgentWireEvent[] = [
  { type: "run:start" },
  { type: "user", messageId: "1", text: "hi", at: 1 },
  { type: "assistant:start", messageId: "stream:2:1" },
  { type: "assistant:delta", messageId: "stream:2:1", channel: "text", delta: "Let me " },
  { type: "tool:draft", toolCallId: "c1", toolName: "rm" },
  { type: "assistant:delta", messageId: "stream:2:1", channel: "text", delta: "check." },
  { type: "assistant:end", messageId: "4", text: "Let me check.", stopReason: "toolUse", at: 2 },
  { type: "tool:start", toolCallId: "c1", toolName: "rm", label: "Remove", tier: "write", args: { path: "/x" } },
  { type: "approval:request", toolCallId: "c1", toolName: "rm", tier: "write", args: { path: "/x" } },
  { type: "approval:resolved", toolCallId: "c1", approved: false, comment: "no" },
  { type: "tool:end", toolCallId: "c1", toolName: "rm", status: "error", error: "declined: no" },
  { type: "assistant:start", messageId: "stream:6:1" },
  { type: "assistant:delta", messageId: "stream:6:1", channel: "text", delta: "OK" },
  { type: "assistant:end", messageId: "7", text: "OK.", stopReason: "stop", at: 3 },
  { type: "run:end", reason: "done" },
];

// What the server replays from storage for the same conversation: no streaming, no drafts.
const replayed: AgentWireEvent[] = [
  { type: "run:start" },
  { type: "user", messageId: "1", text: "hi", at: 1 },
  { type: "assistant:end", messageId: "4", text: "Let me check.", stopReason: "toolUse", at: 2 },
  { type: "tool:start", toolCallId: "c1", toolName: "rm", label: "Remove", tier: "write", args: { path: "/x" } },
  { type: "approval:request", toolCallId: "c1", toolName: "rm", tier: "write", args: { path: "/x" } },
  { type: "approval:resolved", toolCallId: "c1", approved: false, comment: "no" },
  { type: "tool:end", toolCallId: "c1", toolName: "rm", status: "error", error: "declined: no" },
  { type: "assistant:end", messageId: "7", text: "OK.", stopReason: "stop", at: 3 },
  { type: "run:end", reason: "done" },
];

describe("applyEvent", () => {
  it("folds live events and replayed history into the same view", () => {
    const view = foldEvents(live);
    expect(view).toEqual(foldEvents(replayed));
    expect(view.status).toBe("idle");
    expect(view.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(view.items[2]).toMatchObject({
      status: "error",
      approval: { approved: false, comment: "no" },
    });
  });

  it("tracks pending approvals and the run status", () => {
    const view = foldEvents(live.slice(0, 9));
    expect(view.status).toBe("awaiting_approval");
    expect(view.pendingApprovals).toEqual(["c1"]);
    const resolved = applyEvent(view, live[9]!);
    expect(resolved.status).toBe("running");
    expect(resolved.pendingApprovals).toEqual([]);
  });

  it("ends what a run left open, and notes a run that did not finish", () => {
    const view = foldEvents([...live.slice(0, 6), { type: "run:end", reason: "aborted", code: "aborted" }]);
    // The reply that streamed was never stored and the draft never became a call.
    expect(view.items).toEqual([
      { kind: "user", messageId: "1", text: "hi", streaming: false, at: 1 },
      { kind: "notice", reason: "aborted", code: "aborted" },
    ]);
    expect(view.status).toBe("idle");
  });

  it("does not duplicate items a replay sends again, and resets on stream:reset", () => {
    const twice = foldEvents([...replayed, ...replayed]);
    expect(twice.items).toEqual(foldEvents(replayed).items);
    expect(applyEvent(twice, { type: "stream:reset" })).toEqual(emptySessionView());
  });

  it("validates every event with the zod schema", () => {
    for (const event of [...live, ...replayed]) {
      expect(agentWireEventSchema.parse(event)).toEqual(event);
    }
    expect(agentWireEventSchema.safeParse({ type: "tool:end", toolCallId: "x" }).success).toBe(false);
  });
});

describe("resent state", () => {
  it("folds into the same view when a resumed stream sends it again", () => {
    const asked = foldEvents(live.slice(0, 9));
    // A resumed client gets the pending question again: nothing changes.
    expect(applyEvent(asked, live[8]!)).toEqual(asked);
    // The run's end, once folded, is not folded twice.
    const done = foldEvents(live);
    expect(applyEvent(done, { type: "run:end", reason: "aborted", code: "aborted" })).toEqual(done);
    // A question or progress for a call that ended, or a question already decided, changes nothing.
    const ended = foldEvents(live.slice(0, 11));
    expect(applyEvent(ended, live[8]!)).toEqual(ended);
    expect(applyEvent(ended, { type: "tool:update", toolCallId: "c1", output: "late" })).toEqual(ended);
    const decided = foldEvents(live.slice(0, 10));
    expect(applyEvent(decided, live[8]!)).toEqual(decided);
    // The reply streamed so far, sent again as one delta under its stream id, replaces the partial.
    const streaming = foldEvents(live.slice(0, 4));
    const resent = foldEvents(
      [
        { type: "assistant:start", messageId: "stream:2:1" },
        { type: "assistant:delta", messageId: "stream:2:1", channel: "text", delta: "Let me " },
      ],
      streaming,
    );
    expect(resent).toEqual(streaming);
  });
});

describe("the queue", () => {
  const waiting = [
    { submissionId: "5", text: "Then this", whenBusy: "queue" as const },
    { submissionId: "6", text: "This way", whenBusy: "steer" as const },
  ];

  it("holds what the newest queue event lists, across runs, and nothing once it lists none", () => {
    const queued = foldEvents([...live.slice(0, 3), { type: "queue", items: waiting }]);
    expect(queued.queued).toEqual(waiting);
    // A run's end leaves what waits for the next run.
    expect(applyEvent(queued, { type: "run:end", reason: "done" }).queued).toEqual(waiting);
    // Sent again to a resumed client, it changes nothing.
    expect(applyEvent(queued, { type: "queue", items: waiting })).toEqual(queued);
    const emptied = applyEvent(queued, { type: "queue", items: [] });
    expect(emptied).not.toHaveProperty("queued");
    expect(emptied).toEqual(foldEvents(live.slice(0, 3)));
    expect(applyEvent(queued, { type: "stream:reset" })).toEqual(emptySessionView());
  });

  it("marks a user message that steered the run going on", () => {
    const view = foldEvents([
      ...live.slice(0, 2),
      { type: "user", messageId: "9", text: "This way", at: 4, steer: true },
    ]);
    expect(view.items.at(-1)).toEqual({
      kind: "user",
      messageId: "9",
      text: "This way",
      streaming: false,
      at: 4,
      steer: true,
    });
    expect(view.items[0]).not.toHaveProperty("steer");
  });

  it("validates the queue and a steer with the zod schema", () => {
    const events: AgentWireEvent[] = [
      { type: "queue", items: waiting },
      { type: "user", messageId: "9", text: "This way", steer: true },
    ];
    for (const event of events) expect(agentWireEventSchema.parse(event)).toEqual(event);
    const unknown = { type: "queue", items: [{ submissionId: "5", text: "x", whenBusy: "reject" }] };
    expect(agentWireEventSchema.safeParse(unknown).success).toBe(false);
  });
});

describe("a deferred call", () => {
  const start: AgentWireEvent = {
    type: "tool:start",
    toolCallId: "a1",
    toolName: "ask",
    label: "Ask",
    tier: "ask",
    args: { question: "Why?" },
  };
  const wait: AgentWireEvent = { type: "reply:wait", toolCallId: "a1", until: 5_000 };
  const tool = (view: AgentSessionView) => view.items.find((item): item is ToolItem => item.kind === "tool")!;

  it("awaits its reply until its deadline, runs again once the reply resumes it, then ends", () => {
    const waiting = foldEvents([{ type: "run:start" }, start, wait]);
    expect(tool(waiting)).toMatchObject({ status: "awaiting_reply", replyBy: 5_000 });
    // The run goes on while the call is parked: nothing waits for an operator.
    expect(waiting).toMatchObject({ status: "running", pendingApprovals: [] });
    // A resumed stream sends the wait again: nothing changes.
    expect(applyEvent(waiting, wait)).toEqual(waiting);

    // Woken, it runs again without its deadline, as a resumed stream that never sent the wait shows it.
    const resumed = applyEvent(waiting, { type: "tool:update", toolCallId: "a1" });
    expect(tool(resumed)).toEqual({ ...tool(foldEvents([start])), status: "running" });
    expect(applyEvent(foldEvents([{ type: "run:start" }, start]), { type: "tool:update", toolCallId: "a1" })).toEqual(
      resumed,
    );
    const ended = applyEvent(resumed, { type: "tool:end", toolCallId: "a1", toolName: "ask", status: "ok" });
    expect(tool(ended)).toEqual({ ...tool(foldEvents([start])), status: "ok" });
    // Straight from the wait to the end, too, and a wait for a call that ended changes nothing.
    const direct = applyEvent(waiting, { type: "tool:end", toolCallId: "a1", toolName: "ask", status: "ok" });
    expect(direct).toEqual(ended);
    expect(applyEvent(ended, wait)).toEqual(ended);
    expect(agentWireEventSchema.parse(wait)).toEqual(wait);
  });

  it("ends aborted with a run that ends while it waits", () => {
    const view = foldEvents([{ type: "run:start" }, start, wait, { type: "run:end", reason: "aborted" }]);
    expect(tool(view)).toEqual({ ...tool(foldEvents([start])), status: "aborted" });
  });

  it("ignores a wait for a call the view does not hold", () => {
    const view = foldEvents([{ type: "run:start" }]);
    expect(applyEvent(view, wait)).toEqual(view);
  });
});

describe("delegateOf", () => {
  it("names the child session a delegate's call runs, from its start through its end", () => {
    const start: AgentWireEvent = {
      type: "tool:start",
      toolCallId: "d1",
      toolName: "research",
      label: "Research",
      tier: "delegate",
      args: { task: "Find a" },
    };
    const details = { sessionId: "12", agent: "researcher" };
    const running = foldEvents([{ type: "run:start" }, start, { type: "tool:update", toolCallId: "d1", details }]);
    const tool = (view: AgentSessionView) => view.items.find((item): item is ToolItem => item.kind === "tool")!;
    expect(delegateOf(tool(running))).toEqual(details);
    const ended = applyEvent(running, {
      type: "tool:end",
      toolCallId: "d1",
      toolName: "research",
      status: "ok",
      details,
    });
    expect(delegateOf(tool(ended))).toEqual(details);
    // Any other call's details name no child.
    const other = foldEvents([{ type: "run:start" }, { ...start, toolCallId: "c1", toolName: "rm" }]);
    expect(delegateOf(tool(other))).toBeUndefined();
    const noted = applyEvent(other, { type: "tool:update", toolCallId: "c1", details: { sessionId: 12 } });
    expect(delegateOf(tool(noted))).toBeUndefined();
  });
});

describe("cursor", () => {
  it("round-trips its committed position and log place, and rejects foreign strings", () => {
    const positions = [
      { session: "7", entry: 0 },
      { session: "7", entry: 42, run: 40 },
      { session: "7", entry: 42, run: "*" as const },
      { session: "7", entry: 42, run: 40, log: { epoch: "0b6c7a8e1f", seq: 17 } },
      { session: "7", entry: 43, log: { epoch: "0b6c7a8e1f", seq: 0 } },
    ];
    for (const position of positions) {
      const cursor = encodeCursor(position);
      expect(decodeCursor(cursor)).toEqual(position);
      expect(cursorSchema.parse(cursor)).toBe(cursor);
    }
    expect(encodeCursor({ session: "7", entry: 42, run: 40, log: { epoch: "ab", seq: 3 } })).toBe("7.42.40.ab.3");
    for (const foreign of ["nope", "7.01.-", "7.1", "7.1.0", "a:1", "7.1.-.AB.1", "7.1.-.ab"]) {
      expect(decodeCursor(foreign), foreign).toBeUndefined();
    }
    expect(() => encodeCursor({ session: "has space", entry: 1 })).toThrow("Invalid cursor position");
  });
});
