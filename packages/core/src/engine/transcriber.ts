import { contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  defineEntry,
  InboxDoc,
  LiveDoc,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import type {
  ConversationView,
  EntryRecord,
  InboxState,
  JsonObject,
  LiveState,
  NestedToolSlot,
  RunFailure,
  TaskId,
  ToolSlot,
} from "@earendil-works/pi-durable";

import type { AgentWireEvent, AgentWireEventOf, CursorPosition, QueuedInput, Usage } from "@chia1104/motoko-wire";

import { NO_DECISION_IN_TIME } from "./approvals.ts";
import type { Decisions } from "./approvals.ts";
import { startedCall } from "./calls.ts";
import type { Calls } from "./calls.ts";

export interface ToolInfo {
  readonly label: string;
  readonly tier: string;
  readonly gated: boolean;
}

export interface RunEnding {
  readonly reason: string;
  readonly detail?: string;
}

export interface Endings {
  readonly inputs: ReadonlyMap<number, RunEnding>;
  readonly continues: ReadonlyMap<number, RunEnding>;
}

export type Position = Pick<CursorPosition, "entry" | "run">;

export interface Transcribed {
  readonly event: AgentWireEvent;
  readonly position: Position;
}

export interface History {
  pages(min: number | undefined, max: number): AsyncIterable<readonly EntryRecord[]>;
  entry(id: number): Promise<EntryRecord | undefined>;
  runStart(at: number): Promise<number | undefined>;
  decisions(): Promise<Decisions>;
  gateArgs(taskId: TaskId): Promise<JsonObject | undefined>;
  calls(): Promise<Calls>;
  endings(): Promise<Endings>;
}

type GateArgs = ReadonlyMap<string, JsonObject>;
const NO_GATE_ARGS: GateArgs = new Map();

type RunEnd = AgentWireEventOf<"run:end">;
type Compaction = AgentWireEventOf<"compaction:start" | "compaction:end">;
type Wrapup = AgentWireEventOf<"wrapup:start" | "wrapup:end">;
type Batch = { event: AgentWireEvent; run: CursorPosition["run"] }[];
type Block = AssistantMessage["content"][number];

const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text);

function replyText(content: readonly Block[]) {
  let text = "";
  let thinking = "";
  for (const part of content) {
    if (part.type === "text") text += part.text;
    else if (part.type === "thinking") thinking += part.thinking;
  }
  return { text, thinking };
}

function usageOf(message: AssistantMessage): Usage | undefined {
  const { usage } = message;
  if (usage === undefined) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cost?.total !== undefined && { cost: usage.cost.total }),
  };
}

/**
 * pi-ai stores no code on a failed reply, only its text, and this text is the only trace that the request found no
 * credential for its provider (`Models.applyAuth`).
 */
const modelErrorCode = (error: string | undefined) =>
  error?.startsWith("Provider is not configured: ") === true ? "no_credentials" : "model_error";

function runEndOf(message: AssistantMessage): RunEnd | undefined {
  switch (message.stopReason) {
    case "toolUse":
    case "pending":
    case "deferred":
      return undefined;
    case "error":
      return {
        type: "run:end",
        reason: "error",
        code: modelErrorCode(message.errorMessage),
        ...(message.errorMessage !== undefined && { error: clip(message.errorMessage) }),
      };
    case "aborted":
      return { type: "run:end", reason: "aborted", code: "aborted" };
    default:
      return { type: "run:end", reason: "done" };
  }
}

function failureOf({ reason, detail }: RunEnding): RunEnd {
  const extra = detail === undefined ? {} : { error: clip(detail) };
  switch (reason) {
    case "aborted":
    case "reset":
      return { type: "run:end", reason: "aborted", code: reason, ...extra };
    case "interrupted":
    case "restart_limit":
      return { type: "run:end", reason: "interrupted", code: reason, ...extra };
    case "model_error":
      return { type: "run:end", reason: "error", code: modelErrorCode(detail), ...extra };
    default:
      return { type: "run:end", reason: "error", code: reason, ...extra };
  }
}

/** pi-durable keeps `compactionFailure` until a compaction succeeds. */
function compactionOf(live: LiveState | undefined): Compaction {
  const running = live?.compactions?.[0];
  if (running !== undefined) return { type: "compaction:start", reason: running.trigger };
  const failure = live?.compactionFailure;
  return failure === undefined ? { type: "compaction:end" } : { type: "compaction:end", error: clip(failure.error) };
}

/**
 * pi-durable keeps `run.afterRun` from the commit that stores the answer until the run's `afterRun` tasks end, and the
 * session takes no new input meanwhile.
 */
const wrapupOf = (live: LiveState | undefined): Wrapup => ({
  type: live?.run?.afterRun === undefined ? "wrapup:end" : "wrapup:start",
});

const UNFINISHED = new Set(["aborted", "abandoned", "interrupted"]);

function toolEndOf(entry: EntryRecord, message: ToolResultMessage): AgentWireEventOf<"tool:end"> {
  const diagnostics = ToolResultEntry.is(entry) ? entry.data.diagnostics : [];
  const unfinished = diagnostics.some((diagnostic) => UNFINISHED.has(diagnostic.code ?? ""));
  const status = unfinished ? "aborted" : message.isError ? "error" : "ok";
  return {
    type: "tool:end",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    status,
    ...(status === "error" && { error: clip(contentText(message.content, "\n")) }),
    ...(message.details !== undefined && { details: message.details }),
  };
}

// pi-durable wraps a summary in a note for the model; the thread shows what is inside.
const SUMMARY = /<summary>\n([\s\S]*)\n<\/summary>/;

// SAFETY: a view keys each built-in document by its kind, so this holds `pi.live`.
export const liveOf = (view: ConversationView) => view.docs[LiveDoc.definition.kind] as LiveState | undefined;

// SAFETY: a view keys each built-in document by its kind, so this holds `pi.inbox`.
export const inboxOf = (view: ConversationView) => view.docs[InboxDoc.definition.kind] as InboxState | undefined;

function queuedOf(view: ConversationView | undefined): QueuedInput[] {
  const items = view === undefined ? [] : (inboxOf(view)?.items ?? []);
  return items.flatMap((item) =>
    item.mode === "write"
      ? []
      : [
          {
            submissionId: String(item.id),
            // SAFETY: an inbox item holds its input's content as JSON, which is what a user message's content holds.
            text: contentText(item.content as UserMessage["content"], "\n"),
            whenBusy: item.mode === "steer" ? ("steer" as const) : ("queue" as const),
          },
        ],
  );
}

const newestOf = (view: ConversationView): number => view.entries.at(-1)?.id ?? view.before ?? 0;

export const answering = (live: LiveState | undefined) =>
  live?.run !== undefined && live.run.afterRun === undefined ? live.run.inputs[0] : undefined;

const sleeps = (live: LiveState | undefined) =>
  [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].some((slot) => slot.status === "sleeping");

const underWay = (live: LiveState | undefined) =>
  sleeps(live) || live?.tools?.some((slot) => slot.status === "running") === true;

const atGate = (slot: ToolSlot | NestedToolSlot, calls: Calls) =>
  slot.status === "sleeping" && startedCall(calls, slot.callId, slot.taskId) === undefined;

interface Asking {
  readonly name: string;
  readonly args: unknown;
  readonly parent?: string;
}

function nestedOf(live: LiveState | undefined): { slot: NestedToolSlot; call: Asking & { parent: string } }[] {
  const under = new Map<string, string>();
  return (live?.nestedTools ?? []).map((slot) => {
    const parent = under.get(slot.parentCallId) ?? slot.parentCallId;
    under.set(slot.callId, parent);
    return { slot, call: { name: slot.name, args: slot.arguments, parent } };
  });
}

interface Answer {
  readonly approved: boolean;
  readonly comment?: string;
}

const lapsed = (slot: NestedToolSlot): Answer | undefined =>
  slot.summary?.error === NO_DECISION_IN_TIME ? { approved: false, comment: NO_DECISION_IN_TIME } : undefined;

function awaitedReply(slot: ToolSlot, calls: Calls) {
  const record = startedCall(calls, slot.callId, slot.taskId);
  return slot.status === "sleeping" && record?.kind === "reply" && record.repliedAt === undefined ? record : undefined;
}

const deferred = (slot: ToolSlot, calls: Calls) => startedCall(calls, slot.callId, slot.taskId)?.kind === "reply";

export const STEER_ENTRY = "motoko.steer";

/** pi-durable's `pi.user` holds no data. */
export const INPUT_ENTRY = "motoko.input";

export const isInput = (entry: EntryRecord) =>
  (UserEntry.is(entry) || entry.kind === INPUT_ENTRY || entry.kind === STEER_ENTRY) &&
  entry.model?.[0]?.role === "user";

/**
 * pi-durable's continue places no entry, so without this marker history could not tell where the failed run it carries
 * on ended and its own run began.
 */
export const ContinueEntry = defineEntry<{ submissionId: number }>("motoko.continue");

export const mayStartRun = (entry: EntryRecord) => isInput(entry) || ContinueEntry.is(entry);

/** A boundary gives every input it places the same time. */
const placedAt = (entry: EntryRecord) => (entry.model?.[0] as UserMessage | undefined)?.timestamp;

/**
 * pi-durable places a steer at its tool round's post-tools boundary. It places every other input in one of three
 * places. The first is after a run's answer, by the generation that answered, whose reply asked for no tools. The
 * second is into a session no run holds, by no task. The last is where a run failed and hands what waits to the next
 * run, with `afterFailedRun: "continue"`. The entries alone miss one case of the last. A steer that waited for a round
 * whose boundary failed its run reads as joining it.
 */
export function joinsRun(
  entry: EntryRecord,
  previous: EntryRecord | undefined,
  reply: EntryRecord | undefined,
): "with" | "steer" | undefined {
  if (
    previous !== undefined &&
    isInput(previous) &&
    previous.byTaskId === entry.byTaskId &&
    placedAt(previous) === placedAt(entry)
  ) {
    return "with";
  }
  const [message] = reply?.model ?? [];
  const round = message?.role === "assistant" && message.stopReason === "toolUse";
  const placed = entry.byTaskId !== undefined && reply?.byTaskId === entry.byTaskId;
  return entry.kind === STEER_ENTRY && round && placed ? "steer" : undefined;
}

const sameFailure = (a: RunFailure | undefined, b: RunFailure | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.taskId === b.taskId && a.reason === b.reason);

interface Streaming {
  readonly id: string;
  readonly run: number | undefined;
  readonly attempt: number;
  text: string;
  thinking: string;
  readonly drafted: Set<string>;
}

type Held<K> = { readonly known: true; readonly key: K } | { readonly known: false };
const UNKNOWN_HELD: Held<never> = { known: false };
const held = <K>(key: K): Held<K> => ({ known: true, key });
const holds = <K>(state: Held<K>, key: K): boolean => state.known && state.key === key;

const EMPTY_QUEUE = "[]";
const NO_COMPACTION = JSON.stringify({ type: "compaction:end" } satisfies Compaction);
const NO_WRAPUP = JSON.stringify({ type: "wrapup:end" } satisfies Wrapup);

type CommitEnd = { readonly ended: false } | { readonly ended: true; readonly failure: RunEnd | undefined };
const NOT_ENDED: CommitEnd = { ended: false };

export class Transcriber {
  readonly #history: History;
  readonly #info: (toolName: string) => ToolInfo;
  #out: Transcribed[] | undefined;
  #entry = 0;
  #batch: Batch | undefined;
  #open = new Map<string, { name: string; args: unknown }>();
  #asked = new Set<string>();
  #resolved = new Set<string>();
  #awaiting = new Set<string>();
  #inRun = false;
  #runEntry: number | undefined;
  #runContinue: number | undefined;
  #pending: RunEnd | undefined;
  #streaming: Streaming | undefined;
  #retry: Held<string | undefined> = held(undefined);
  #endings: Endings | undefined;
  #last: EntryRecord | undefined;
  #reply: EntryRecord | undefined;
  #steered = false;
  #over: CommitEnd = NOT_ENDED;
  #queue: Held<string> = held(EMPTY_QUEUE);
  #compaction: Held<string> = held(NO_COMPACTION);
  #wrapup: Held<string> = held(NO_WRAPUP);

  constructor(history: History, info: (toolName: string) => ToolInfo) {
    this.#history = history;
    this.#info = info;
  }

  get position(): Position {
    const run = this.#run();
    return { entry: this.#entry, ...(run !== undefined && { run }) };
  }

  async start(view: ConversationView): Promise<void> {
    const live = liveOf(view);
    const newest = newestOf(view);
    if (answering(live) !== undefined) {
      await this.#rebuild("*", newest);
      const calls = await this.#callsFor(live, underWay);
      this.#resync(live, await this.#history.decisions(), calls, await this.#gateArgsFor(live, calls));
    }
    this.#at(newest);
    this.#queueState(view);
    this.#compactionState(live);
    this.#wrapupState(live);
  }

  async restore({ entry, run }: Position): Promise<boolean> {
    if (entry > 0 && (await this.#history.entry(entry)) === undefined) return false;
    this.#queue = UNKNOWN_HELD;
    this.#compaction = UNKNOWN_HELD;
    this.#wrapup = UNKNOWN_HELD;
    if (run === undefined || (run !== "*" && run > entry)) {
      this.#at(entry);
      if (run !== undefined) this.#assume(run);
      return true;
    }
    if (run !== "*") {
      const first = await this.#history.entry(run);
      if (first === undefined || !mayStartRun(first)) return false;
    }
    await this.#rebuild(run, entry);
    this.#assume(run);
    return true;
  }

  standing(view: ConversationView | undefined): readonly Transcribed[] {
    return this.#collect(() => {
      this.#queueState(view);
      this.#compactionState(view === undefined ? undefined : liveOf(view));
    });
  }

  async *replay(to: number): AsyncGenerator<readonly Transcribed[], void, undefined> {
    const [decisions, endings] = await Promise.all([this.#history.decisions(), this.#history.endings()]);
    for await (const page of this.#history.pages(this.#entry + 1, to)) {
      yield this.#collect(() => this.#entries(page, decisions, endings));
    }
  }

  async catchUp(to: number, view: ConversationView | undefined): Promise<readonly Transcribed[]> {
    const live = view === undefined ? undefined : liveOf(view);
    const decisions = await this.#history.decisions();
    const calls = await this.#callsFor(live, underWay);
    const gateArgs = await this.#gateArgsFor(live, calls);
    const rest = to > this.#entry ? await this.#range(this.#entry + 1, to) : [];
    const endings = rest.some(mayStartRun) ? await this.#history.endings() : undefined;
    return this.#collect(() => {
      this.#entries(rest, decisions, endings);
      this.#at(to);
      this.#aroundRunEnd(live, () => {
        this.#resync(live, decisions, calls, gateArgs);
        this.#queueState(view);
      });
    });
  }

  async commit(was: ConversationView, next: ConversationView): Promise<readonly Transcribed[]> {
    let entries = next.entries.filter((entry) => entry.id > this.#entry);
    if (next.before !== undefined && next.before > this.#entry) {
      // The window moved past entries not read yet, because a commit appended more entries than the window holds.
      entries = [...(await this.#range(this.#entry + 1, next.before)), ...entries];
    }
    const before = liveOf(was);
    const now = liveOf(next);
    const calls = await this.#callsFor(now);
    const gateArgs = await this.#gateArgsFor(now, calls);
    const someWaitingCallDecided = this.#waiting(now, calls).length > gateArgs.size;
    const decisions =
      someWaitingCallDecided || this.#needsDecisions(before, now, entries, calls)
        ? await this.#history.decisions()
        : {};
    const failure =
      now?.runFailure && !sameFailure(now.runFailure, before?.runFailure) ? failureOf(now.runFailure) : undefined;
    return this.#collect(() => {
      const unstarted = () => answering(now) !== undefined && !this.#inRun;
      if (unstarted() && !entries.some(mayStartRun)) this.#startRun(undefined);
      const ended = answering(before) !== undefined && answering(before) !== answering(now);
      this.#over = ended ? { ended: true, failure } : NOT_ENDED;
      try {
        this.#entries(entries, decisions);
      } finally {
        this.#over = NOT_ENDED;
      }
      if (unstarted()) this.#startRun(undefined);
      this.#retryState(now);
      if (answering(now) !== undefined) this.#stream(now);
      this.#slots(before?.tools, now?.tools, decisions, calls, gateArgs);
      this.#nested(now, decisions, calls, gateArgs);
      this.#queueState(next);
      this.#aroundRunEnd(now, () => {
        if (answering(now) === undefined && this.#inRun) this.#endRun(decisions, failure);
      });
      this.#at(newestOf(next));
    });
  }

  async #callsFor(live: LiveState | undefined, needed = sleeps): Promise<Calls> {
    return needed(live) ? this.#history.calls() : {};
  }

  #waiting(live: LiveState | undefined, calls: Calls): (ToolSlot | NestedToolSlot)[] {
    return [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].filter(
      (slot) => atGate(slot, calls) && !this.#asked.has(slot.callId),
    );
  }

  async #gateArgsFor(live: LiveState | undefined, calls: Calls): Promise<GateArgs> {
    const waiting = this.#waiting(live, calls);
    if (waiting.length === 0) return NO_GATE_ARGS;
    const read = await Promise.all(
      waiting.map(async ({ callId, taskId }) => {
        const args = taskId === undefined ? undefined : await this.#history.gateArgs(taskId);
        return args === undefined ? [] : [[callId, args] as const];
      }),
    );
    return new Map(read.flat());
  }

  #run(): CursorPosition["run"] {
    return this.#inRun ? (this.#runEntry ?? "*") : undefined;
  }

  #at(entry: number) {
    this.#entry = Math.max(this.#entry, entry);
  }

  #assume(run: number | "*") {
    this.#inRun = true;
    this.#runEntry = run === "*" ? undefined : run;
    this.#retry = UNKNOWN_HELD;
  }

  async #rebuild(run: number | "*", entry: number) {
    const start = run === "*" ? await this.#history.runStart(entry) : run;
    this.#entries(await this.#range(start, entry), {});
    this.#at(entry);
  }

  async #range(min: number | undefined, max: number): Promise<EntryRecord[]> {
    const entries: EntryRecord[] = [];
    for await (const page of this.#history.pages(min, max)) entries.push(...page);
    return entries;
  }

  #collect(read: () => void): Transcribed[] {
    const out: Transcribed[] = [];
    this.#out = out;
    try {
      read();
    } finally {
      this.#out = undefined;
    }
    return out;
  }

  #emit(event: AgentWireEvent) {
    if (this.#batch) this.#batch.push({ event, run: this.#run() });
    else this.#out?.push({ event, position: this.position });
  }

  #entries(entries: readonly EntryRecord[], decisions: Decisions, endings?: Endings) {
    this.#endings = endings;
    for (const entry of entries) {
      if (entry.id <= this.#entry) continue;
      const batch: Batch = [];
      this.#batch = batch;
      const before = this.#entry;
      try {
        this.#read(entry, decisions);
      } finally {
        this.#batch = undefined;
      }
      this.#entry = entry.id;
      this.#last = entry;
      batch.forEach(({ event, run }, index) => {
        const at = index === batch.length - 1 ? entry.id : before;
        this.#out?.push({ event, position: { entry: at, ...(run !== undefined && { run }) } });
      });
    }
  }

  #resync(live: LiveState | undefined, decisions: Decisions, calls: Calls, gateArgs: GateArgs) {
    if (answering(live) === undefined) {
      this.#endRun(decisions, live?.runFailure && failureOf(live.runFailure));
      return;
    }
    if (!this.#inRun) this.#startRun(undefined);
    for (const slot of live?.tools ?? []) {
      if (!this.#open.has(slot.callId)) continue;
      if (atGate(slot, calls)) {
        this.#ask(slot.callId, this.#open.get(slot.callId), decisions, gateArgs);
        continue;
      }
      this.#decision(slot.callId, decisions);
      if (slot.status === "running" || slot.status === "sleeping") this.#progress(slot, undefined);
      this.#replyWait(slot, calls, true);
    }
    this.#nested(live, decisions, calls, gateArgs);
    this.#retryState(live);
    this.#stream(live);
  }

  #needsDecisions(
    was: LiveState | undefined,
    now: LiveState | undefined,
    entries: readonly EntryRecord[],
    calls: Calls,
  ): boolean {
    const undecided = (callId: string, call = this.#open.get(callId)) => {
      if (call === undefined || this.#resolved.has(callId)) return false;
      return this.#asked.has(callId) || this.#info(call.name).gated;
    };
    const closing =
      answering(now) === undefined || entries.some((entry) => AssistantEntry.is(entry) || mayStartRun(entry));
    if (closing && [...this.#open.keys()].some((callId) => undecided(callId))) return true;
    for (const entry of entries) {
      const [message] = entry.model ?? [];
      if (message?.role === "toolResult" && undecided(message.toolCallId)) return true;
    }
    for (const slot of was?.tools ?? []) {
      if (slot.status !== "sleeping" || !undecided(slot.callId)) continue;
      const next = now?.tools?.find((candidate) => candidate.callId === slot.callId);
      if (next === undefined || !atGate(next, calls)) return true;
    }
    const before = new Map((was?.nestedTools ?? []).map((slot) => [slot.callId, slot.status]));
    for (const { slot, call } of nestedOf(now)) {
      if (!this.#open.has(call.parent) || slot.status === "pending" || atGate(slot, calls)) continue;
      if (before.get(slot.callId) !== slot.status && undecided(slot.callId, call)) return true;
    }
    return false;
  }

  #startRun(runEntry: number | undefined) {
    this.#wrapupState(undefined);
    this.#inRun = true;
    this.#runEntry = runEntry;
    this.#runContinue = undefined;
    this.#pending = undefined;
    this.#asked.clear();
    this.#resolved.clear();
    this.#awaiting.clear();
    this.#emit({ type: "run:start" });
  }

  #endRun(decisions: Decisions, failure?: RunEnd) {
    this.#closeOpen(decisions);
    if (!holds(this.#retry, undefined)) {
      this.#retry = held(undefined);
      this.#emit({ type: "retry:end" });
    }
    const end = this.#inRun ? (failure ?? this.#pending ?? { type: "run:end", reason: "interrupted" }) : undefined;
    this.#inRun = false;
    this.#runEntry = undefined;
    this.#runContinue = undefined;
    this.#pending = undefined;
    this.#streaming = undefined;
    this.#asked.clear();
    this.#resolved.clear();
    this.#awaiting.clear();
    if (end) this.#emit(end);
  }

  #closeOpen(decisions: Decisions) {
    for (const [toolCallId, { name }] of this.#open) {
      this.#decision(toolCallId, decisions);
      this.#emit({ type: "tool:end", toolCallId, toolName: name, status: "aborted" });
    }
    this.#open.clear();
    this.#awaiting.clear();
  }

  #decision(
    toolCallId: string,
    decisions: Decisions,
    call = this.#open.get(toolCallId),
    decision: Answer | undefined = decisions[toolCallId],
  ) {
    if (decision === undefined || this.#resolved.has(toolCallId)) return;
    this.#ask(toolCallId, call, decisions);
    this.#resolved.add(toolCallId);
    this.#emit({
      type: "approval:resolved",
      toolCallId,
      approved: decision.approved,
      ...(decision.comment !== undefined && { comment: decision.comment }),
    });
  }

  #ask(toolCallId: string, call: Asking | undefined, decisions: Decisions, gateArgs = NO_GATE_ARGS) {
    if (call === undefined || this.#asked.has(toolCallId) || this.#resolved.has(toolCallId)) return;
    this.#asked.add(toolCallId);
    this.#emit({
      type: "approval:request",
      toolCallId,
      toolName: call.name,
      tier: this.#info(call.name).tier,
      args: decisions[toolCallId]?.args ?? gateArgs.get(toolCallId) ?? call.args,
      ...(call.parent !== undefined && { parentToolCallId: call.parent }),
    });
  }

  #read(entry: EntryRecord, decisions: Decisions) {
    const [message] = entry.model ?? [];
    const resumed = this.#inRun && this.#runEntry === entry.id;

    if (ContinueEntry.is(entry)) {
      if (!resumed) this.#nextRun(entry, decisions);
      this.#runContinue = entry.data.submissionId;
      return;
    }

    if (isInput(entry) && message?.role === "user") {
      const joined =
        resumed || !this.#inRun || this.#runOver(entry) ? undefined : joinsRun(entry, this.#last, this.#reply);
      if (!resumed && joined === undefined) this.#nextRun(entry, decisions);
      this.#steered = joined === "steer" || (joined === "with" && this.#steered);
      const user: UserMessage = message;
      this.#emit({
        type: "user",
        messageId: String(entry.id),
        text: contentText(user.content, "\n"),
        at: user.timestamp,
        ...(this.#steered && { steer: true as const }),
      });
      return;
    }

    if (AssistantEntry.is(entry) && message?.role === "assistant") {
      this.#reply = entry;
      const reply: AssistantMessage = message;
      this.#closeOpen(decisions);
      const { text, thinking } = replyText(reply.content);
      this.#emit({
        type: "assistant:end",
        messageId: String(entry.id),
        text,
        ...(thinking.length > 0 && { thinking }),
        stopReason: reply.stopReason,
        ...(reply.errorMessage !== undefined && { error: clip(reply.errorMessage) }),
        ...(usageOf(reply) !== undefined && { usage: usageOf(reply) }),
        at: reply.timestamp,
      });
      this.#streaming = undefined;
      if (reply.stopReason === "toolUse") {
        for (const part of reply.content) {
          if (part.type !== "toolCall") continue;
          const info = this.#info(part.name);
          this.#open.set(part.id, { name: part.name, args: part.arguments });
          this.#emit({
            type: "tool:start",
            toolCallId: part.id,
            toolName: part.name,
            label: info.label,
            tier: info.tier,
            args: part.arguments,
          });
        }
      }
      this.#pending = runEndOf(reply);
      if (this.#pending?.reason === "done") this.#endRun(decisions);
      return;
    }

    if (ToolResultEntry.is(entry) && message?.role === "toolResult") {
      const result: ToolResultMessage = message;
      if (this.#open.has(result.toolCallId)) this.#decision(result.toolCallId, decisions);
      const end = toolEndOf(entry, result);
      if (end.status === "aborted") this.#pending = { type: "run:end", reason: "aborted", code: "aborted" };
      this.#open.delete(result.toolCallId);
      this.#awaiting.delete(result.toolCallId);
      this.#emit(end);
      return;
    }

    if (CompactionEntry.is(entry) && message?.role === "user") {
      const text = contentText(message.content, "\n");
      this.#emit({
        type: "session:compacted",
        messageId: String(entry.id),
        summary: SUMMARY.exec(text)?.[1] ?? text,
        at: message.timestamp,
      });
    }
  }

  #nextRun(entry: EntryRecord, decisions: Decisions) {
    const ending = this.#ending();
    const failure = this.#over.ended ? this.#over.failure : undefined;
    this.#endRun(decisions, failure ?? (ending && failureOf(ending)));
    this.#over = NOT_ENDED;
    this.#startRun(entry.id);
  }

  #ending(): RunEnding | undefined {
    if (this.#runContinue !== undefined) return this.#endings?.continues.get(this.#runContinue);
    return this.#runEntry === undefined ? undefined : this.#endings?.inputs.get(this.#runEntry);
  }

  #runOver(entry: EntryRecord): boolean {
    if (this.#over.ended) return true;
    const ending = this.#ending();
    if (ending === undefined) return false;
    const own = this.#endings?.inputs.get(entry.id);
    return own?.reason !== ending.reason || own.detail !== ending.detail;
  }

  #queueState(view: ConversationView | undefined) {
    const items = queuedOf(view);
    const key = JSON.stringify(items);
    if (holds(this.#queue, key)) return;
    this.#queue = held(key);
    this.#emit({ type: "queue", items });
  }

  #slots(
    was: readonly ToolSlot[] | undefined,
    now: readonly ToolSlot[] | undefined,
    decisions: Decisions,
    calls: Calls,
    gateArgs: GateArgs,
  ) {
    const before = new Map((was ?? []).map((slot) => [slot.callId, slot]));
    for (const slot of now ?? []) {
      if (!this.#open.has(slot.callId)) continue;
      const previous = before.get(slot.callId);
      if (atGate(slot, calls)) {
        this.#ask(slot.callId, this.#open.get(slot.callId), decisions, gateArgs);
        continue;
      }
      if (previous?.status === "sleeping") this.#decision(slot.callId, decisions);
      if (slot.status === "running" || slot.status === "sleeping") this.#progress(slot, previous);
      this.#replyWait(slot, calls);
    }
  }

  #nested(live: LiveState | undefined, decisions: Decisions, calls: Calls, gateArgs: GateArgs) {
    for (const { slot, call } of nestedOf(live)) {
      if (!this.#open.has(call.parent)) continue;
      if (atGate(slot, calls)) this.#ask(slot.callId, call, decisions, gateArgs);
      else if (slot.status !== "pending") {
        this.#decision(slot.callId, decisions, call, decisions[slot.callId] ?? lapsed(slot));
      }
    }
  }

  #replyWait(slot: ToolSlot, calls: Calls, resync = false) {
    const awaited = awaitedReply(slot, calls);
    const toolCallId = slot.callId;
    if (awaited !== undefined && !this.#awaiting.has(toolCallId)) {
      this.#awaiting.add(toolCallId);
      this.#emit({ type: "reply:wait", toolCallId, until: awaited.until });
    } else if (awaited === undefined && (this.#awaiting.delete(toolCallId) || (resync && deferred(slot, calls)))) {
      this.#emit({ type: "tool:update", toolCallId });
    }
  }

  #progress(slot: ToolSlot, previous: ToolSlot | undefined) {
    const output = slot.output !== previous?.output ? slot.output : undefined;
    const details = slot.details !== previous?.details ? slot.details : undefined;
    if (output === undefined && details === undefined) return;
    this.#emit({
      type: "tool:update",
      toolCallId: slot.callId,
      ...(output !== undefined && { output }),
      ...(details !== undefined && { details }),
    });
  }

  #aroundRunEnd(live: LiveState | undefined, mayEndRun: () => void) {
    this.#compactionState(live);
    mayEndRun();
    this.#wrapupState(live);
  }

  #compactionState(live: LiveState | undefined) {
    const event = compactionOf(live);
    const key = JSON.stringify(event);
    if (holds(this.#compaction, key)) return;
    this.#compaction = held(key);
    this.#emit(event);
  }

  #wrapupState(live: LiveState | undefined) {
    const event = wrapupOf(live);
    const key = JSON.stringify(event);
    if (holds(this.#wrapup, key)) return;
    this.#wrapup = held(key);
    this.#emit(event);
  }

  #retryState(live: LiveState | undefined) {
    const retry = answering(live) === undefined ? undefined : live?.generation?.retry;
    const key = retry && `${retry.at}:${retry.error}`;
    if (holds(this.#retry, key)) return;
    this.#retry = held(key);
    if (retry) this.#emit({ type: "retry:wait", error: clip(retry.error), at: retry.at });
    else this.#emit({ type: "retry:end" });
  }

  #stream(live: LiveState | undefined) {
    const generation = live?.generation;
    const partial = generation?.message as AssistantMessage | undefined;
    if (generation === undefined || partial === undefined) return;
    const { text, thinking } = replyText(partial.content);
    const run = live?.run?.taskId as number | undefined;
    let streaming = this.#streaming;
    if (
      streaming === undefined ||
      streaming.run !== run ||
      streaming.attempt !== generation.attempt ||
      !text.startsWith(streaming.text) ||
      !thinking.startsWith(streaming.thinking)
    ) {
      streaming = {
        id: `stream:${run ?? 0}:${generation.attempt}`,
        run,
        attempt: generation.attempt,
        text: "",
        thinking: "",
        drafted: new Set(),
      };
      this.#streaming = streaming;
      this.#emit({ type: "assistant:start", messageId: streaming.id });
    }
    if (thinking.length > streaming.thinking.length) {
      this.#emit({
        type: "assistant:delta",
        messageId: streaming.id,
        channel: "thinking",
        delta: thinking.slice(streaming.thinking.length),
      });
      streaming.thinking = thinking;
    }
    if (text.length > streaming.text.length) {
      this.#emit({
        type: "assistant:delta",
        messageId: streaming.id,
        channel: "text",
        delta: text.slice(streaming.text.length),
      });
      streaming.text = text;
    }
    for (const part of partial.content) {
      if (part.type !== "toolCall" || !part.id || !part.name || streaming.drafted.has(part.id)) continue;
      streaming.drafted.add(part.id);
      this.#emit({ type: "tool:draft", toolCallId: part.id, toolName: part.name });
    }
  }
}
