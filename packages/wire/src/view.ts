import * as z from "zod";

import { UNKNOWN_TIER } from "./events.ts";
import type {
  AgentWireEvent,
  AgentWireEventOf,
  CompactionReason,
  QueuedInput,
  RunEndReason,
  ToolEndStatus,
  Usage,
} from "./events.ts";

export interface MessageItem {
  readonly kind: "user" | "assistant";
  /** The entry id once stored; a stream id while an assistant reply streams. */
  readonly messageId: string;
  readonly text: string;
  readonly thinking?: string;
  readonly streaming: boolean;
  readonly stopReason?: string;
  readonly error?: string;
  readonly usage?: Usage;
  readonly at?: number;
  /** A user message that joined a run going on, after one of its tool rounds. */
  readonly steer?: true;
}

export type ToolStatus = "drafting" | "running" | "awaiting_approval" | "awaiting_reply" | ToolEndStatus;

/** A call a tool call made through pi-durable's `executeTool()` (a code mode script's, say) that was asked about. */
export interface NestedApproval {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly tier: string;
  /** The arguments it runs with. */
  readonly args: unknown;
  /** The decision, once made; until then it waits for one. */
  readonly approval?: { readonly approved: boolean; readonly comment?: string };
}

export interface ToolItem {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly label: string;
  readonly tier: string;
  readonly args: unknown;
  readonly status: ToolStatus;
  /** Retained running output; cleared when the call ends. */
  readonly progress?: string;
  readonly details?: unknown;
  readonly error?: string;
  readonly approval?: { readonly approved: boolean; readonly comment?: string };
  /** A deferred call's deadline, epoch ms, while it waits for its reply. */
  readonly replyBy?: number;
  /** The calls it made that were asked about, in the order they asked, while it runs: they end with it. */
  readonly nestedApprovals?: readonly NestedApproval[];
}

/** A delegate's call's details, from its start: the child session its sub-agent runs in, and the sub-agent's kind. */
export const delegateDetailsSchema = z.object({ sessionId: z.string(), agent: z.string() });
export type DelegateDetails = z.output<typeof delegateDetailsSchema>;

/** The child session a delegate's call runs its sub-agent in, for a client to follow; undefined for any other call. */
export function delegateOf(item: ToolItem): DelegateDetails | undefined {
  const parsed = delegateDetailsSchema.safeParse(item.details);
  return parsed.success ? parsed.data : undefined;
}

export interface CompactionItem {
  readonly kind: "compaction";
  readonly messageId: string;
  readonly summary: string;
  readonly at?: number;
}

/** A run that ended any way but `done`. */
export interface RunNoticeItem {
  readonly kind: "notice";
  readonly reason: Exclude<RunEndReason, "done">;
  readonly code?: string;
  readonly error?: string;
}

export type SessionViewItem = MessageItem | ToolItem | CompactionItem | RunNoticeItem;

export type RunStatus = "idle" | "running" | "awaiting_approval";

/** A compaction going on, or why the newest one failed. */
export type CompactionState =
  | { readonly status: "running"; readonly reason: CompactionReason }
  | { readonly status: "failed"; readonly error: string };

export interface AgentSessionView {
  readonly items: readonly SessionViewItem[];
  /** Tool call ids waiting for a decision, in the order they asked. */
  readonly pendingApprovals: readonly string[];
  readonly status: RunStatus;
  /** Why the model request failed, while it waits to be sent again. */
  readonly retrying?: { readonly error: string; readonly at: number };
  /** The inputs waiting for a run, in the order they were submitted; absent while none waits. */
  readonly queued?: readonly QueuedInput[];
  /** A compaction going on, or the newest one's failure until a later one succeeds; absent otherwise. */
  readonly compaction?: CompactionState;
  /** The run answered and the session still runs its `afterRun` tasks, so it takes no new input yet; absent otherwise. */
  readonly wrappingUp?: true;
}

export const emptySessionView = (): AgentSessionView => ({
  items: [],
  pendingApprovals: [],
  status: "idle",
});

const isTool = (item: SessionViewItem | undefined, toolCallId: string): item is ToolItem =>
  item?.kind === "tool" && item.toolCallId === toolCallId;

/** A call whose run is going: one that ended with it gets no result. */
const OPEN: ReadonlySet<ToolStatus> = new Set(["running", "awaiting_approval", "awaiting_reply"]);

/** A call that ended: nothing but its own end event changes it again. */
const hasEnded = (item: ToolItem) => item.status === "ok" || item.status === "error" || item.status === "aborted";

const isStreaming = (item: SessionViewItem): item is MessageItem => item.kind === "assistant" && item.streaming;

const withoutDrafts = (items: readonly SessionViewItem[]) =>
  items.filter((item) => item.kind !== "tool" || item.status !== "drafting");

function statusOf(running: boolean, pending: readonly string[]): RunStatus {
  if (!running) return "idle";
  return pending.length > 0 ? "awaiting_approval" : "running";
}

function settle(
  view: AgentSessionView,
  items: readonly SessionViewItem[],
  pendingApprovals: readonly string[] = view.pendingApprovals,
  running: boolean = view.status !== "idle",
): AgentSessionView {
  return { ...view, items, pendingApprovals, status: statusOf(running, pendingApprovals) };
}

/** Replaces the tool item `toolCallId`, or appends `create()` when there is none. */
function upsertTool(
  items: SessionViewItem[],
  toolCallId: string,
  update: (found: ToolItem | undefined) => ToolItem,
): SessionViewItem[] {
  const index = items.findIndex((item) => isTool(item, toolCallId));
  const found = index === -1 ? undefined : (items[index] as ToolItem);
  const next = update(found);
  if (index === -1) items.push(next);
  else items[index] = next;
  return items;
}

const placeholderTool = (toolCallId: string, toolName: string): ToolItem => ({
  kind: "tool",
  toolCallId,
  toolName,
  label: toolName,
  tier: UNKNOWN_TIER,
  args: undefined,
  status: "running",
});

function assistantEnd(view: AgentSessionView, event: AgentWireEventOf<"assistant:end">) {
  const items = withoutDrafts(view.items).slice();
  const message: MessageItem = {
    kind: "assistant",
    messageId: event.messageId,
    text: event.text,
    ...(event.thinking !== undefined && { thinking: event.thinking }),
    streaming: false,
    stopReason: event.stopReason,
    ...(event.error !== undefined && { error: event.error }),
    ...(event.usage !== undefined && { usage: event.usage }),
    ...(event.at !== undefined && { at: event.at }),
  };
  // The stored reply replaces the one that streamed for it: one generation streams at a time.
  let index = items.findIndex((item) => item.kind === "assistant" && item.messageId === event.messageId);
  if (index === -1) index = items.findIndex(isStreaming);
  if (index === -1) items.push(message);
  else items[index] = message;
  return settle(view, items);
}

/**
 * The question of a nested call, under the call it was made under. A call that ended, or that the view does not hold,
 * waits on nothing; a question already decided waits no more.
 */
function nestedRequest(view: AgentSessionView, event: AgentWireEventOf<"approval:request">, parentToolCallId: string) {
  const index = view.items.findIndex((item) => isTool(item, parentToolCallId));
  const parent = view.items[index];
  if (parent?.kind !== "tool" || hasEnded(parent)) return view;
  const nested = parent.nestedApprovals ?? [];
  const asked = nested.findIndex((item) => item.toolCallId === event.toolCallId);
  if (nested[asked]?.approval !== undefined) return view;
  const question: NestedApproval = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    tier: event.tier,
    args: event.args,
  };
  const items = view.items.slice();
  items[index] = {
    ...parent,
    nestedApprovals: asked === -1 ? [...nested, question] : nested.with(asked, question),
  };
  const pending = view.pendingApprovals.includes(event.toolCallId)
    ? view.pendingApprovals
    : [...view.pendingApprovals, event.toolCallId];
  return settle(view, items, pending);
}

/** The decision of a nested call, on its question under the call it was made under, if the view holds it. */
function nestedDecision(items: SessionViewItem[], event: AgentWireEventOf<"approval:resolved">): void {
  const index = items.findIndex(
    (item) => item.kind === "tool" && item.nestedApprovals?.some((nested) => nested.toolCallId === event.toolCallId),
  );
  const parent = items[index];
  if (parent?.kind !== "tool" || parent.nestedApprovals === undefined) return;
  const approval = { approved: event.approved, ...(event.comment !== undefined && { comment: event.comment }) };
  items[index] = {
    ...parent,
    nestedApprovals: parent.nestedApprovals.map((nested) =>
      nested.toolCallId === event.toolCallId ? { ...nested, approval } : nested,
    ),
  };
}

function runEnd(view: AgentSessionView, event: AgentWireEventOf<"run:end">): AgentSessionView {
  // Nothing of the run goes on: a call still open gets no result, a reply still streaming was never
  // stored, and a draft never became a call.
  const items: SessionViewItem[] = [];
  for (const item of view.items) {
    if (item.kind === "tool" && item.status === "drafting") continue;
    if (isStreaming(item)) continue;
    if (item.kind === "tool" && OPEN.has(item.status)) {
      const { progress: _progress, replyBy: _replyBy, nestedApprovals: _nested, ...rest } = item;
      items.push({ ...rest, status: "aborted" });
      continue;
    }
    items.push(item);
  }
  if (event.reason !== "done") {
    items.push({
      kind: "notice",
      reason: event.reason,
      ...(event.code !== undefined && { code: event.code }),
      ...(event.error !== undefined && { error: event.error }),
    });
  }
  const { retrying: _retrying, ...rest } = view;
  return { ...rest, items, pendingApprovals: [], status: "idle" };
}

/**
 * Pure: the same events in the same order always give the same view, so a replayed transcript and
 * the live stream share one renderer. Every event that names an item upserts it, and state a resumed
 * stream sends again is applied idempotently: a stored item already held, a question for a call
 * still waiting, the reply streamed so far, a run's end the view already shows (`run:end` while
 * idle), progress or a question for a call that already ended. So a client resuming from a cursor
 * folds into the view of a client connected all along.
 */
export function applyEvent(view: AgentSessionView, event: AgentWireEvent): AgentSessionView {
  switch (event.type) {
    case "stream:reset":
      return emptySessionView();

    case "run:start":
      return settle(view, view.items, view.pendingApprovals, true);

    case "user": {
      if (view.items.some((item) => item.kind === "user" && item.messageId === event.messageId)) return view;
      const items = view.items.slice();
      items.push({
        kind: "user",
        messageId: event.messageId,
        text: event.text,
        streaming: false,
        ...(event.at !== undefined && { at: event.at }),
        ...(event.steer === true && { steer: true }),
      });
      return settle(view, items);
    }

    case "assistant:start": {
      // A new attempt supersedes drafts and any reply an abandoned attempt left streaming.
      const items: SessionViewItem[] = withoutDrafts(view.items).filter((item) => !isStreaming(item));
      items.push({ kind: "assistant", messageId: event.messageId, text: "", streaming: true });
      return settle(view, items);
    }

    case "assistant:delta": {
      const index = view.items.findLastIndex(
        (item) => item.kind === "assistant" && item.streaming && item.messageId === event.messageId,
      );
      const message = view.items[index];
      if (message?.kind !== "assistant") return view;
      const items = view.items.slice();
      items[index] =
        event.channel === "text"
          ? { ...message, text: message.text + event.delta }
          : { ...message, thinking: (message.thinking ?? "") + event.delta };
      return settle(view, items);
    }

    case "assistant:end":
      return assistantEnd(view, event);

    case "tool:draft": {
      if (view.items.some((item) => isTool(item, event.toolCallId))) return view;
      const items = view.items.slice();
      items.push({ ...placeholderTool(event.toolCallId, event.toolName), status: "drafting" });
      return settle(view, items);
    }

    case "tool:start": {
      const items = upsertTool(view.items.slice(), event.toolCallId, (found) => ({
        ...(found ?? placeholderTool(event.toolCallId, event.toolName)),
        toolName: event.toolName,
        label: event.label,
        tier: event.tier,
        args: event.args,
        status: found && found.status !== "drafting" ? found.status : "running",
      }));
      return settle(view, items);
    }

    case "tool:update": {
      const index = view.items.findIndex((item) => isTool(item, event.toolCallId));
      const tool = view.items[index];
      if (tool?.kind !== "tool" || hasEnded(tool)) return view;
      const items = view.items.slice();
      // A call that publishes progress runs: one that waited for its reply has it, or its deadline passed.
      const { replyBy: _replyBy, ...call } = tool;
      items[index] = {
        ...call,
        ...(tool.status === "awaiting_reply" && { status: "running" }),
        ...(event.output !== undefined && { progress: event.output }),
        ...(event.details !== undefined && { details: event.details }),
      };
      return settle(view, items);
    }

    case "tool:end": {
      // The questions of the calls it made end with it.
      const ending = new Set([event.toolCallId]);
      const items = upsertTool(view.items.slice(), event.toolCallId, (found) => {
        const {
          progress: _progress,
          error: _error,
          details: _details,
          replyBy: _replyBy,
          nestedApprovals,
          ...base
        } = found ?? placeholderTool(event.toolCallId, event.toolName);
        for (const nested of nestedApprovals ?? []) ending.add(nested.toolCallId);
        return {
          ...base,
          status: event.status,
          ...(event.error !== undefined && { error: event.error }),
          ...(event.details !== undefined && { details: event.details }),
        };
      });
      return settle(
        view,
        items,
        view.pendingApprovals.filter((id) => !ending.has(id)),
      );
    }

    case "approval:request": {
      if (event.parentToolCallId !== undefined) return nestedRequest(view, event, event.parentToolCallId);
      const asked = view.items.find((item) => isTool(item, event.toolCallId));
      // A call that ended waits for nothing; one already decided waits no more.
      if (asked?.kind === "tool" && (hasEnded(asked) || asked.approval !== undefined)) return view;
      // The question carries the arguments the call runs with, which may not be those the model wrote.
      const items = upsertTool(view.items.slice(), event.toolCallId, (found) => ({
        ...(found ?? { ...placeholderTool(event.toolCallId, event.toolName), tier: event.tier }),
        args: event.args,
        status: "awaiting_approval",
      }));
      const pending = view.pendingApprovals.includes(event.toolCallId)
        ? view.pendingApprovals
        : [...view.pendingApprovals, event.toolCallId];
      return settle(view, items, pending);
    }

    case "approval:resolved": {
      const index = view.items.findIndex((item) => isTool(item, event.toolCallId));
      const tool = view.items[index];
      const items = view.items.slice();
      if (tool?.kind === "tool") {
        items[index] = {
          ...tool,
          approval: {
            approved: event.approved,
            ...(event.comment !== undefined && { comment: event.comment }),
          },
          // Decided, not yet run: the call's own `tool:end` settles it.
          status: tool.status === "awaiting_approval" ? "running" : tool.status,
        };
      } else {
        nestedDecision(items, event);
      }
      return settle(
        view,
        items,
        view.pendingApprovals.filter((id) => id !== event.toolCallId),
      );
    }

    case "reply:wait": {
      const index = view.items.findIndex((item) => isTool(item, event.toolCallId));
      const tool = view.items[index];
      // A call that ended waits for nothing.
      if (tool?.kind !== "tool" || hasEnded(tool)) return view;
      const items = view.items.slice();
      items[index] = {
        ...tool,
        status: "awaiting_reply",
        ...(event.until !== undefined && { replyBy: event.until }),
      };
      return settle(view, items);
    }

    case "retry:wait":
      return { ...view, retrying: { error: event.error, at: event.at } };

    case "retry:end": {
      const { retrying: _retrying, ...rest } = view;
      return rest;
    }

    case "queue": {
      const { queued: _queued, ...rest } = view;
      return event.items.length === 0 ? rest : { ...rest, queued: event.items };
    }

    case "compaction:start":
      return { ...view, compaction: { status: "running", reason: event.reason } };

    case "compaction:end": {
      if (event.error !== undefined) return { ...view, compaction: { status: "failed", error: event.error } };
      const { compaction: _compaction, ...rest } = view;
      return rest;
    }

    case "session:compacted": {
      if (view.items.some((item) => item.kind === "compaction" && item.messageId === event.messageId)) return view;
      const items = view.items.slice();
      items.push({
        kind: "compaction",
        messageId: event.messageId,
        summary: event.summary,
        ...(event.at !== undefined && { at: event.at }),
      });
      return settle(view, items);
    }

    case "run:end":
      // The view shows no run: this end was folded already.
      return view.status === "idle" ? view : runEnd(view, event);

    case "wrapup:start":
      return { ...view, wrappingUp: true };

    case "wrapup:end": {
      const { wrappingUp: _wrappingUp, ...rest } = view;
      return rest;
    }

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export const foldEvents = (
  events: Iterable<AgentWireEvent>,
  initial: AgentSessionView = emptySessionView(),
): AgentSessionView => {
  let view = initial;
  for (const event of events) view = applyEvent(view, event);
  return view;
};
