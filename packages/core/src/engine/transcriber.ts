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
  LiveState,
  RunFailure,
  ToolSlot,
} from "@earendil-works/pi-durable";

import type { AgentWireEvent, AgentWireEventOf, CursorPosition, QueuedInput, Usage } from "@chia1104/motoko-wire";

import type { Decisions } from "./approvals.ts";
import { startedCall } from "./calls.ts";
import type { Calls } from "./calls.ts";

/**
 * Turns committed conversation state into wire events. Stored facts (messages, tool calls, results,
 * decisions, run ends) come from entries and documents; what only `pi.live` shows (a streaming
 * reply, drafts, running output, a retry wait, a parked question, a compaction going on) is
 * superseded by the stored events that follow it. One set of rules serves the live stream (`commit`
 * as each commit lands), a catch-up from storage (`replay` of a stretch of history), and a resumed
 * client (`catchUp`: the in-flight state as events the reducer applies idempotently).
 *
 * A run starts at an input, or at the marker a continue writes (`ContinueEntry`), and takes every input placed into it
 * after one of its tool rounds (a steer) or with that input; the inputs still waiting for a run go out as the queue,
 * whole, whenever it changes.
 *
 * After every event the transcriber knows its position, a cursor's `entry` and `run`: the newest
 * entry whose events all went out, and the run the client is in. That is what a cursor names, so a client can resume from it in
 * any process: `restore` reads the entries of its run up to the position and silently rebuilds this
 * state. What the transcriber needs of history it reads itself, through its `History`.
 */

export interface ToolInfo {
  readonly label: string;
  readonly tier: string;
  /**
   * Whether a call of the tool waits for approval in this session now. Only what is not settled yet reads it: a call
   * parked at the gate is asked about and a stored decision goes out whatever the session's rule says by then.
   */
  readonly gated: boolean;
}

/** Why a run ended without an answer: `pi.live.runFailure`'s reason and detail, or its inputs' settlement. */
export interface RunEnding {
  readonly reason: string;
  readonly detail?: string;
}

/** Endings of past runs that ended without an answer: what a stretch of history cannot show. */
export interface Endings {
  /** By the input that started each run. */
  readonly inputs: ReadonlyMap<number, RunEnding>;
  /** By the submission of each continue whose run its marker started. */
  readonly continues: ReadonlyMap<number, RunEnding>;
}

/**
 * Where a client stands in committed state: wire's `CursorPosition` without the session and the log place, which
 * only the stream that hands out cursors knows.
 */
export type Position = Pick<CursorPosition, "entry" | "run">;

/** An event, and where it leaves the client that folds it. */
export interface Transcribed {
  readonly event: AgentWireEvent;
  readonly position: Position;
}

/** What the transcriber reads of a session's committed state. */
export interface History {
  /** The conversation's entries from `min` (default: its first) through `max`, oldest first, a page at a time. */
  pages(min: number | undefined, max: number): AsyncIterable<readonly EntryRecord[]>;
  /** The entry `id`, if the conversation holds it. */
  entry(id: number): Promise<EntryRecord | undefined>;
  /** The entry at or before `at` that started the run going on at `at`, if one did: an input or a continue's marker. */
  runStart(at: number): Promise<number | undefined>;
  /** The operator's decisions on gated calls, by call id. */
  decisions(): Promise<Decisions>;
  /** The calls the runtime runs itself that have started, by call id. */
  calls(): Promise<Calls>;
  /** How each run that ended without an answer ended. */
  endings(): Promise<Endings>;
}

type RunEnd = AgentWireEventOf<"run:end">;
type Compaction = AgentWireEventOf<"compaction:start" | "compaction:end">;
type Batch = { event: AgentWireEvent; run: CursorPosition["run"] }[];
type Block = AssistantMessage["content"][number];

/** The error text a client is shown for a failed call or reply. */
const clip = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Text and thinking of a reply, each with its parts joined as they streamed. */
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
 * The code of a run a model error ended. pi-ai stores no code on a failed reply, only its text, and this text is the
 * only trace that the request found no credential for its provider (`Models.applyAuth`). Pinned by "a user's key
 * changing while the instance is open" in `test/access.test.ts`, and for a reply alone by "ends with no_credentials
 * when its failed reply found no credential for the provider" in `test/transcriber.test.ts`.
 */
const modelErrorCode = (error: string | undefined) =>
  error?.startsWith("Provider is not configured: ") === true ? "no_credentials" : "model_error";

/** How a reply ends its run; `undefined` while the run goes on to run its tools. */
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

/** Why a run ended without an answer, as pi-durable records it, in the wire's terms. */
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

/**
 * What a client is shown of the compactions in `live`: the one going on (the first, in task order), else the newest
 * one's failure, which pi-durable keeps until a compaction succeeds, else none.
 */
function compactionOf(live: LiveState | undefined): Compaction {
  const running = live?.compactions?.[0];
  if (running !== undefined) return { type: "compaction:start", reason: running.trigger };
  const failure = live?.compactionFailure;
  return failure === undefined ? { type: "compaction:end" } : { type: "compaction:end", error: clip(failure.error) };
}

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
/** A view's `pi.live`; empty before the conversation's first run. */
export const liveOf = (view: ConversationView) => view.docs[LiveDoc.definition.kind] as LiveState | undefined;

// SAFETY: a view keys each built-in document by its kind, so this holds `pi.inbox`.
/** A view's `pi.inbox`: what waits for a boundary of the conversation. */
export const inboxOf = (view: ConversationView) => view.docs[InboxDoc.definition.kind] as InboxState | undefined;

/** The inputs waiting in a view's inbox, in submission order; the entry writes waiting with them are no inputs. */
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

/** The newest entry a view reaches; 0 for an empty conversation. */
const newestOf = (view: ConversationView): number => view.entries.at(-1)?.id ?? view.before ?? 0;

/** The run that is still to answer, by the input that started it; a run past its answer is over. */
export const answering = (live: LiveState | undefined) =>
  live?.run !== undefined && live.run.afterRun === undefined ? live.run.inputs[0] : undefined;

/** Whether any call sleeps: at the gate, or parked on its own work once started. */
const sleeps = (live: LiveState | undefined) => live?.tools?.some((slot) => slot.status === "sleeping") === true;

/** Whether any call sleeps or runs: a running one may be a deferred call that a reply or its deadline woke. */
const underWay = (live: LiveState | undefined) =>
  live?.tools?.some((slot) => slot.status === "sleeping" || slot.status === "running") === true;

/** Whether a call waits at the gate: it sleeps before it started. A started call that sleeps waits on its own work. */
const atGate = (slot: ToolSlot, calls: Calls) =>
  slot.status === "sleeping" && startedCall(calls, slot.callId, slot.taskId) === undefined;

/** A deferred call's record while it is parked on its reply: it sleeps, and no reply reached it yet. */
function awaitedReply(slot: ToolSlot, calls: Calls) {
  const record = startedCall(calls, slot.callId, slot.taskId);
  return slot.status === "sleeping" && record?.kind === "reply" && record.repliedAt === undefined ? record : undefined;
}

/** Whether a call is a deferred one that started: parked on its reply, woken from it, or on its way to the park. */
const deferred = (slot: ToolSlot, calls: Calls) => startedCall(calls, slot.callId, slot.taskId)?.kind === "reply";

/**
 * The kind of the entry a steer is placed as, whichever run it lands in: what it was submitted as is stored with it, so
 * an input submitted to wait for a run's answer never reads as one that joined a run.
 */
export const STEER_ENTRY = "motoko.steer";

/** Whether an entry is an input: a user message the session was given, which starts a run or joins the one going on. */
export const isInput = (entry: EntryRecord) =>
  (UserEntry.is(entry) || entry.kind === STEER_ENTRY) && entry.model?.[0]?.role === "user";

/**
 * The marker a continue writes in the commit that admits it, when its run takes no input: pi-durable's continue places
 * no entry, so without one, history could not tell where the failed run it carries on ended and its own run began. It
 * names the continue's submission, whose settlement says how that run ended. Nothing the model reads.
 */
export const ContinueEntry = defineEntry<{ submissionId: number }>("motoko.continue");

/** Whether an entry may start a run: a continue's marker, or an input unless it joins the run going on. */
export const mayStartRun = (entry: EntryRecord) => isInput(entry) || ContinueEntry.is(entry);

/** When an input's message was made: a boundary gives every input it places the same time. */
const placedAt = (entry: EntryRecord) => (entry.model?.[0] as UserMessage | undefined)?.timestamp;

/**
 * How `entry`, an input, joins the run of the entries before it instead of starting one, if it does: `with` the input
 * right before it, which the same boundary placed; or as a `steer`, submitted as one (`STEER_ENTRY`) and placed after
 * the results of a tool round by the generation whose reply, the newest before it, asked for them. pi-durable places a
 * steer at that round's post-tools boundary, and every other input after a run's answer (by the generation that
 * answered, whose reply asked for no tools), or into a session no run holds (by no task), or where a run failed and
 * hands what waits to the next run (`afterFailedRun: "continue"`). The entries alone miss one case of the last: a steer
 * that waited for a round whose boundary failed its run reads as joining it. A transcriber, which knows that run ended
 * (its commit, or its inputs' settlement), starts a run with it.
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

/** Stands for "unknown": the next resync states the retry wait either way. */
const UNKNOWN_RETRY = "\0unknown";

/** The queue as a client holds it before any `queue` event: empty. */
const EMPTY_QUEUE = "[]";
/** Stands for "unknown": a resumed client may hold any queue, so the catch-up states it. */
const UNKNOWN_QUEUE = "\0unknown";

/** The compaction state a client holds before any compaction event: none. */
const NO_COMPACTION = JSON.stringify({ type: "compaction:end" } satisfies Compaction);
/** Stands for "unknown": a resumed client may hold any compaction state, so the catch-up states it. */
const UNKNOWN_COMPACTION = "\0unknown";

export class Transcriber {
  readonly #history: History;
  readonly #info: (toolName: string) => ToolInfo;
  /** What the call under way sends; none while the state is rebuilt silently. */
  #out: Transcribed[] | undefined;
  #entry = 0;
  /** Events of the entry being read, held until it is done, so the last one names the entry. */
  #batch: Batch | undefined;
  /** Calls whose start went out and whose end has not, with what they were called with. */
  #open = new Map<string, { name: string; args: unknown }>();
  /** Gated calls of this run whose question went out, and those whose decision went out too. */
  #asked = new Set<string>();
  #resolved = new Set<string>();
  /** Deferred calls of this run whose wait for a reply went out, while they wait. */
  #awaiting = new Set<string>();
  #inRun = false;
  #runEntry: number | undefined;
  /** The continue whose marker started the run going on, by its submission. */
  #runContinue: number | undefined;
  /** How the run ends if nothing follows: its last reply, or a call stopped with it. */
  #pending: RunEnd | undefined;
  #streaming: Streaming | undefined;
  #retry: string | undefined;
  #endings: Endings | undefined;
  /** The newest entry read, and the newest reply: what tells an input that joins the run going on. */
  #last: EntryRecord | undefined;
  #reply: EntryRecord | undefined;
  /** Whether the newest input read joined its run as a steer. */
  #steered = false;
  /**
   * While a commit is read in which the run going on before it ended: the failure it ended with (`null`: none
   * recorded). No input the commit placed joins that run.
   */
  #over: RunEnd | null | undefined;
  /** The queue the client holds, as JSON. */
  #queue = EMPTY_QUEUE;
  /** The compaction state the client holds, as the JSON of the event that stated it. */
  #compaction = NO_COMPACTION;

  constructor(history: History, info: (toolName: string) => ToolInfo) {
    this.#history = history;
    this.#info = info;
  }

  get position(): Position {
    const run = this.#run();
    return { entry: this.#entry, ...(run !== undefined && { run }) };
  }

  /**
   * Silently takes up the conversation as `view` shows it, to follow its commits from there. Only
   * the run going on matters (what came before it is settled), so only its entries are read.
   */
  async start(view: ConversationView): Promise<void> {
    const live = liveOf(view);
    const newest = newestOf(view);
    if (answering(live) !== undefined) {
      await this.#rebuild("*", newest);
      this.#resync(live, await this.#history.decisions(), await this.#callsFor(live, underWay));
    }
    this.#at(newest);
    this.#queueState(view);
    this.#compactionState(live);
  }

  /**
   * Silently rebuilds what a client at `position` knows: nothing of a run when it is between runs,
   * else the entries of its run up to the position. False, with nothing read, when storage does not
   * hold the position.
   */
  async restore({ entry, run }: Position): Promise<boolean> {
    if (entry > 0 && (await this.#history.entry(entry)) === undefined) return false;
    // A client may hold queued inputs a run took or that were withdrawn since it left, or a compaction that is over:
    // the catch-up states both.
    this.#queue = UNKNOWN_QUEUE;
    this.#compaction = UNKNOWN_COMPACTION;
    if (run === undefined || (run !== "*" && run > entry)) {
      this.#at(entry);
      // Inside the entry that starts the run: the run has begun, nothing of it is read yet.
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

  /**
   * The queue and the compaction state as `view` holds them, where the client may hold others: what a catch-up states
   * first, so a resumed client drops inputs that left the queue, and a compaction that ended, while it was away before
   * history replays (which changes neither). The same for every client from the same cursor, whenever it resumes.
   */
  standing(view: ConversationView | undefined): readonly Transcribed[] {
    return this.#collect(() => {
      this.#queueState(view);
      this.#compactionState(view === undefined ? undefined : liveOf(view));
    });
  }

  /**
   * What was committed after the position through `to`, a page of entries at a time: the history a
   * client catches up on outside the commit chain.
   */
  async *replay(to: number): AsyncGenerator<readonly Transcribed[], void, undefined> {
    // The two reads are independent, so they share one round trip's wait on a remote storage.
    const [decisions, endings] = await Promise.all([this.#history.decisions(), this.#history.endings()]);
    for await (const page of this.#history.pages(this.#entry + 1, to)) {
      yield this.#collect(() => this.#entries(page, decisions, endings));
    }
  }

  /**
   * What was committed after the position through `to`, then the in-flight state `view` shows and its queue: the end
   * of a catch-up, where the client meets the commits that follow.
   */
  async catchUp(to: number, view: ConversationView | undefined): Promise<readonly Transcribed[]> {
    const live = view === undefined ? undefined : liveOf(view);
    const decisions = await this.#history.decisions();
    const calls = await this.#callsFor(live, underWay);
    const rest = to > this.#entry ? await this.#range(this.#entry + 1, to) : [];
    const endings = rest.some(mayStartRun) ? await this.#history.endings() : undefined;
    return this.#collect(() => {
      this.#entries(rest, decisions, endings);
      this.#at(to);
      // Before the in-flight state, which may end the run: a run's end stays its last event.
      this.#compactionState(live);
      this.#resync(live, decisions, calls);
      this.#queueState(view);
    });
  }

  /** The events of one commit: what `next` shows that `was` did not. */
  async commit(was: ConversationView, next: ConversationView): Promise<readonly Transcribed[]> {
    let entries = next.entries.filter((entry) => entry.id > this.#entry);
    if (next.before !== undefined && next.before > this.#entry) {
      // The window moved past entries not read yet: a commit appended more than it holds.
      entries = [...(await this.#range(this.#entry + 1, next.before)), ...entries];
    }
    const before = liveOf(was);
    const now = liveOf(next);
    const calls = await this.#callsFor(now);
    const decisions = this.#needsDecisions(before, now, entries, calls) ? await this.#history.decisions() : {};
    const failure =
      now?.runFailure && !sameFailure(now.runFailure, before?.runFailure) ? failureOf(now.runFailure) : undefined;
    return this.#collect(() => {
      // A run that no entry starts begins before anything of it goes out, so every cursor of the run
      // names it: before this commit's entries unless one of them starts a run, else after them. With
      // no run going, the first input starts one.
      const unstarted = () => answering(now) !== undefined && !this.#inRun;
      if (unstarted() && !entries.some(mayStartRun)) this.#startRun(undefined);
      const ended = answering(before) !== undefined && answering(before) !== answering(now);
      this.#over = ended ? (failure ?? null) : undefined;
      try {
        this.#entries(entries, decisions);
      } finally {
        this.#over = undefined;
      }
      if (unstarted()) this.#startRun(undefined);
      this.#retryState(now);
      if (answering(now) !== undefined) this.#stream(now);
      this.#slots(before?.tools, now?.tools, decisions, calls);
      this.#queueState(next);
      this.#compactionState(now);
      // A run's end last, so it stays the run's last event.
      if (answering(now) === undefined && this.#inRun) this.#endRun(decisions, failure);
      this.#at(newestOf(next));
    });
  }

  /**
   * The started calls, read only when `needed` holds: by default when a call sleeps, which tells a call at the gate
   * from one parked on its own work. A resync needs them also for a running call, which may be a woken deferred one.
   */
  async #callsFor(live: LiveState | undefined, needed = sleeps): Promise<Calls> {
    return needed(live) ? this.#history.calls() : {};
  }

  #run(): CursorPosition["run"] {
    return this.#inRun ? (this.#runEntry ?? "*") : undefined;
  }

  /** Places the transcriber at `entry` without reading anything: the entries before it are done. */
  #at(entry: number) {
    this.#entry = Math.max(this.#entry, entry);
  }

  /**
   * Takes a client's word that it is in run `run`, after the entries of that run up to the
   * client's position were read silently (or, for a run whose user entry is not read yet, none).
   */
  #assume(run: number | "*") {
    this.#inRun = true;
    this.#runEntry = run === "*" ? undefined : run;
    // A resumed client may still show a retry wait; the resync says whether it is over.
    this.#retry = UNKNOWN_RETRY;
  }

  /**
   * Silently reads the run going on at `entry` through `entry`, from its user entry (`"*"`: the
   * newest at or before `entry`). Without decisions: a call the rebuild leaves open is undecided,
   * and its decision goes out where it next shows.
   */
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

  /** Runs `read` with what it sends collected, and returns that. */
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

  /**
   * Stored entries, oldest first: what each adds to the transcript. `endings` says how a run ended
   * that a later user entry closes without its end in view, as in history read from storage.
   */
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
      // Every event of an entry but its last resumes from before it: reading the entry again sends
      // what the client missed of it, and what it had already folds the same.
      batch.forEach(({ event, run }, index) => {
        const at = index === batch.length - 1 ? entry.id : before;
        this.#out?.push({ event, position: { entry: at, ...(run !== undefined && { run }) } });
      });
    }
  }

  /**
   * The current in-flight state as events, after the entries are read: the run going on or its end,
   * questions for calls at the gate, decisions of calls that left it, the output and details of calls
   * under way, the wait of a deferred call parked on its reply or the update that says a woken one runs
   * again, a retry wait, and the reply streamed so far as one delta per channel. A client that holds
   * any of it already folds the same view.
   */
  #resync(live: LiveState | undefined, decisions: Decisions, calls: Calls) {
    if (answering(live) === undefined) {
      this.#endRun(decisions, live?.runFailure && failureOf(live.runFailure));
      return;
    }
    if (!this.#inRun) this.#startRun(undefined);
    for (const slot of live?.tools ?? []) {
      if (!this.#open.has(slot.callId)) continue;
      if (atGate(slot, calls)) {
        this.#ask(slot.callId);
        continue;
      }
      // A decided call that left the gate: the live stream said so as it left.
      this.#decision(slot.callId, decisions);
      if (slot.status === "running" || slot.status === "sleeping") this.#progress(slot, undefined);
      this.#replyWait(slot, calls, true);
    }
    this.#retryState(live);
    this.#stream(live);
  }

  /**
   * Whether a commit from `was` to `now` with `entries` may need the stored decisions: a gated call
   * whose decision has not gone out left the gate, got its result, or is closed with its round.
   */
  #needsDecisions(
    was: LiveState | undefined,
    now: LiveState | undefined,
    entries: readonly EntryRecord[],
    calls: Calls,
  ): boolean {
    const undecided = (callId: string) => {
      const call = this.#open.get(callId);
      if (call === undefined || this.#resolved.has(callId)) return false;
      // Asked about: gated when it parked, whatever the session's rule says now.
      return this.#asked.has(callId) || this.#info(call.name).gated;
    };
    // Open calls are closed, each with its decision, when a reply follows or the run ends.
    const closing =
      answering(now) === undefined || entries.some((entry) => AssistantEntry.is(entry) || mayStartRun(entry));
    if (closing && [...this.#open.keys()].some(undecided)) return true;
    for (const entry of entries) {
      const [message] = entry.model ?? [];
      if (message?.role === "toolResult" && undecided(message.toolCallId)) return true;
    }
    for (const slot of was?.tools ?? []) {
      if (slot.status !== "sleeping" || !undecided(slot.callId)) continue;
      const next = now?.tools?.find((candidate) => candidate.callId === slot.callId);
      if (next === undefined || !atGate(next, calls)) return true;
    }
    return false;
  }

  #startRun(runEntry: number | undefined) {
    this.#inRun = true;
    this.#runEntry = runEntry;
    this.#runContinue = undefined;
    this.#pending = undefined;
    // Call ids never cross runs: what a run asked is forgotten with it.
    this.#asked.clear();
    this.#resolved.clear();
    this.#awaiting.clear();
    this.#emit({ type: "run:start" });
  }

  /** Ends the run under way, if any: as `failure` says, else as its last reply did, else interrupted. */
  #endRun(decisions: Decisions, failure?: RunEnd) {
    this.#closeOpen(decisions);
    if (this.#retry !== undefined) {
      this.#retry = undefined;
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

  /** Closes the calls whose results never came: their round is over. */
  #closeOpen(decisions: Decisions) {
    for (const [toolCallId, { name }] of this.#open) {
      this.#decision(toolCallId, decisions);
      this.#emit({ type: "tool:end", toolCallId, toolName: name, status: "aborted" });
    }
    this.#open.clear();
    this.#awaiting.clear();
  }

  /** The stored decision of a call, after its question if that has not gone out: a decision answers one. */
  #decision(toolCallId: string, decisions: Decisions) {
    const decision = decisions[toolCallId];
    if (decision === undefined || this.#resolved.has(toolCallId)) return;
    this.#ask(toolCallId);
    this.#resolved.add(toolCallId);
    this.#emit({
      type: "approval:resolved",
      toolCallId,
      approved: decision.approved,
      ...(decision.comment !== undefined && { comment: decision.comment }),
    });
  }

  #ask(toolCallId: string) {
    const call = this.#open.get(toolCallId);
    if (call === undefined || this.#asked.has(toolCallId) || this.#resolved.has(toolCallId)) return;
    this.#asked.add(toolCallId);
    this.#emit({
      type: "approval:request",
      toolCallId,
      toolName: call.name,
      tier: this.#info(call.name).tier,
      args: call.args,
    });
  }

  #read(entry: EntryRecord, decisions: Decisions) {
    const [message] = entry.model ?? [];
    // A client resuming inside this entry is in its run already.
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
      // A reply follows its round: a call of it still open never got a result.
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
      // A final answer ends its run; one that failed may still be followed by a retry.
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

  /** Ends the run going on, if any, as the commit being read or history says it ended, and starts one at `entry`. */
  #nextRun(entry: EntryRecord, decisions: Decisions) {
    const ending = this.#ending();
    this.#endRun(decisions, this.#over ?? (ending && failureOf(ending)));
    this.#over = undefined;
    this.#startRun(entry.id);
  }

  /** How history says the run going on ended, if it ended without an answer. */
  #ending(): RunEnding | undefined {
    if (this.#runContinue !== undefined) return this.#endings?.continues.get(this.#runContinue);
    return this.#runEntry === undefined ? undefined : this.#endings?.inputs.get(this.#runEntry);
  }

  /**
   * Whether the run going on ended before `entry`, an input: the commit being read ended it, or history says it ended
   * without an answer and the input, which would have ended with it, did not end that way.
   */
  #runOver(entry: EntryRecord): boolean {
    if (this.#over !== undefined) return true;
    const ending = this.#ending();
    if (ending === undefined) return false;
    const own = this.#endings?.inputs.get(entry.id);
    return own?.reason !== ending.reason || own.detail !== ending.detail;
  }

  /** The inputs `view` holds queued, when the client may hold others. */
  #queueState(view: ConversationView | undefined) {
    const items = queuedOf(view);
    const key = JSON.stringify(items);
    if (key === this.#queue) return;
    this.#queue = key;
    this.#emit({ type: "queue", items });
  }

  /**
   * Questions for calls that parked at the gate, decisions for those that left it, and progress of calls under way,
   * also of one parked on its own work, whose details say what it waits for.
   */
  #slots(
    was: readonly ToolSlot[] | undefined,
    now: readonly ToolSlot[] | undefined,
    decisions: Decisions,
    calls: Calls,
  ) {
    const before = new Map((was ?? []).map((slot) => [slot.callId, slot]));
    for (const slot of now ?? []) {
      if (!this.#open.has(slot.callId)) continue;
      const previous = before.get(slot.callId);
      if (atGate(slot, calls)) {
        this.#ask(slot.callId);
        continue;
      }
      if (previous?.status === "sleeping") this.#decision(slot.callId, decisions);
      if (slot.status === "running" || slot.status === "sleeping") this.#progress(slot, previous);
      this.#replyWait(slot, calls);
    }
  }

  /**
   * A deferred call's wait for its reply, once, while it is parked on it; then, once a reply or the deadline woke it,
   * an update that says it runs again: after the wait that went out, or, in a resync, after one the client may hold.
   */
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

  /** What a running call published since `previous`; everything it holds without one. */
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

  /** The compaction going on in `live`, or the newest one's failure, when the client holds another. */
  #compactionState(live: LiveState | undefined) {
    const event = compactionOf(live);
    const key = JSON.stringify(event);
    if (key === this.#compaction) return;
    this.#compaction = key;
    this.#emit(event);
  }

  #retryState(live: LiveState | undefined) {
    const retry = answering(live) === undefined ? undefined : live?.generation?.retry;
    const key = retry && `${retry.at}:${retry.error}`;
    if (key === this.#retry) return;
    this.#retry = key;
    if (retry) this.#emit({ type: "retry:wait", error: clip(retry.error), at: retry.at });
    else this.#emit({ type: "retry:end" });
  }

  /** The reply streaming now: its start when it is new, then what is new of it, and its drafted calls. */
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
