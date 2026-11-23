import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { configure, ConversationBusy, createRegistry, Harness } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  Conversation,
  ConversationId,
  HarnessOptions,
  ModelRef,
  Report,
  Storage,
  SubmissionId,
  ToolRegistration,
  Wake,
} from "@earendil-works/pi-durable";

import { replyAddressSchema, UNKNOWN_TIER } from "@chia1104/motoko-wire";
import type { Cursor, ReplyAddress, StreamItem } from "@chia1104/motoko-wire";

import { agentsOf, defineAgent } from "./agent.ts";
import type { AgentDefinition } from "./agent.ts";
import { decide, isGated, ruleOf } from "./engine/approvals.ts";
import type { ApprovalDecision, ApprovalOutcome } from "./engine/approvals.ts";
import { ask, askCourier, COURIER_TIMING } from "./engine/asks.ts";
import type { Courier, CourierTiming, DeliverReply, ReplyFailure } from "./engine/asks.ts";
import { agentExtensions } from "./engine/bind.ts";
import { InstanceLifecycle } from "./engine/lifecycle.ts";
import type { Clock, InstanceInspection, InstanceState } from "./engine/lifecycle.ts";
import { ModelAccess } from "./engine/models.ts";
import type { ModelsResolver } from "./engine/models.ts";
import { applyReply } from "./engine/replies.ts";
import type { ReplyInput, ReplyResult } from "./engine/replies.ts";
import { selectedTools, SessionsDoc, storedRule, withChildren } from "./engine/sessions.ts";
import type { ApprovalRule, SessionRecord, ToolSelection } from "./engine/sessions.ts";
import { STEER_ENTRY } from "./engine/transcriber.ts";
import type { ToolInfo } from "./engine/transcriber.ts";
import { SessionWatch } from "./engine/watch.ts";
import {
  InstanceClosedError,
  InvalidRequestError,
  LeaseHeldError,
  SessionBusyError,
  SessionNotFoundError,
  SessionOwnedError,
} from "./errors.ts";
import { assertScope, scopeKey } from "./host.ts";
import type { AgentHost, HostWake, Lease, StorageScope } from "./host.ts";
import type { PortsResolver, PortsTarget } from "./tool.ts";

const context = BACKGROUND_CONTEXT;

/** The sessions record (`SessionsDoc`) as a snapshot reads it. */
interface SessionsState {
  readonly sessions: Readonly<Record<string, Readonly<SessionRecord>>>;
  readonly erasing: readonly number[];
}

/**
 * Why the runtime itself reports: a session's commit it could not turn into events, a failed cleanup or
 * host call, `modelsFor` failing for an instance, a reopen for a due sleep that failed, or the host
 * failing to erase deleted sessions (tried again at the instance's next close).
 */
export type AgentRuntimeReportKind =
  | "listener_error"
  | "close_failed"
  | "lease_release_failed"
  | "arm_failed"
  | "models_failed"
  | "reopen_failed"
  | "erase_failed";

/**
 * A failure that fails no call of the app's, about one instance. `source: "pi"` carries
 * pi-durable's report exactly as `HarnessOptions.onReport` received it; `source: "runtime"` is the
 * runtime's own. `ports_failed` names the tool call whose ports `portsFor` could not resolve; that call
 * ended with an error result. `reply_failed` names an ask of the instance whose reply `deliverReply` failed to
 * deliver (it is tried again unless `gaveUp`), or whose request was first submitted without a reply address.
 */
export type InstanceReport =
  | { readonly source: "pi"; readonly scope: StorageScope; readonly report: Report }
  | {
      readonly source: "runtime";
      readonly scope: StorageScope;
      readonly kind: AgentRuntimeReportKind;
      readonly error: unknown;
    }
  | {
      readonly source: "runtime";
      readonly scope: StorageScope;
      readonly kind: "ports_failed";
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly error: unknown;
    }
  | ({ readonly source: "runtime"; readonly scope: StorageScope; readonly kind: "reply_failed" } & ReplyFailure);

interface AgentRuntimeCommonOptions<Ports> {
  readonly agents: readonly AgentDefinition<Ports>[];
  readonly host: AgentHost;
  /** The model of a new session that names none and whose agent names none. */
  readonly defaultModel?: ModelRef;
  /** Failures that fail no call: pi-durable's reports (a tool task that faulted, a storage failure) and the runtime's. */
  readonly onReport?: (report: InstanceReport) => void;
  /**
   * Closes an instance once it has been idle this long, in ms: its Harness closes, its lease is
   * released and the runtime lets it go. Any handle the app still holds reopens it at its next call.
   * Idle means no call of the runtime's under way on it, no event reader attached, no task that can
   * run now or is running, and no sleep due within this time. Default: an instance stays open
   * until `close()`.
   */
  readonly closeIdleAfterMs?: number;
  /**
   * pi-durable's `HarnessOptions.settings` (such as `progress`), passed to every instance's Harness, read at each use
   * as pi-durable reads it. `extensions` is the runtime's: a session selects its own agent's.
   */
  readonly settings?: HarnessOptions["settings"];
  /**
   * The telemetry of one instance, from its scope: pi-durable's `HarnessOptions.telemetry` (a pi-telemetry
   * `TelemetryContext`), which receives its content-free `pi.durable.*` spans and metrics. Called each time the
   * instance opens. Default: pi-durable's, which records nothing.
   */
  readonly telemetryFor?: (scope: StorageScope) => NonNullable<HarnessOptions["telemetry"]>;
  /**
   * How the runtime reaches a reply address: an ask's run ended, so its answer goes to the asker's instance, through
   * the app's way to reach that instance's home (the local runtime's `session.reply`, a client of the cluster, a
   * Durable Object's stub). Resolve once the reply was delivered or refused for good (map `reply_not_pending` and
   * `session_not_found` to resolving); reject to have it tried again later. Without it, `submit` refuses `replyTo`.
   */
  readonly deliverReply?: DeliverReply;
}

/**
 * Model access: one `models` for every instance, or `modelsFor`, resolved per instance from its
 * scope, so each instance runs on its own caller's credentials.
 */
export type AgentRuntimeModelsOption =
  | {
      /** pi-ai model access for every instance, passed to pi-durable's `HarnessOptions.models` as is. */
      readonly models: HarnessOptions["models"];
      readonly modelsFor?: never;
    }
  | {
      /**
       * The model access of one instance, from its scope: what `models` would be for it. It may be
       * async. Resolved when the instance opens (also when it reopens after a restart or an idle
       * close) and again before every `submit`, `approve` and `resume`, and on `refreshModels()`;
       * pi-durable reads the newest result at each model request. A throw or rejection is
       * reported as `models_failed`, and every model request fails with `ModelsUnavailableError`
       * until a later resolution succeeds.
       */
      readonly modelsFor: ModelsResolver;
      readonly models?: never;
    };

/** Ports: one object for every tool call, or `portsFor`, resolved for each call from where it runs. */
export type AgentRuntimePortsOption<Ports> =
  | {
      /** Handed to every tool call as `context.ports`. */
      readonly ports: Ports;
      readonly portsFor?: never;
    }
  | {
      /**
       * The ports of one tool call, from its scope and session, resolved right before it
       * executes (after its approval, and again for a call a restart reruns). It may be async; a
       * failure fails that call alone and is reported as `ports_failed`.
       */
      readonly portsFor: PortsResolver<Ports>;
      readonly ports?: never;
    };

export type AgentRuntimeOptions<Ports> = AgentRuntimeCommonOptions<Ports> &
  AgentRuntimeModelsOption &
  AgentRuntimePortsOption<Ports>;

export interface SessionInfo {
  readonly id: string;
  /** Epoch ms. */
  readonly createdAt: number;
}

export interface SessionOptions {
  /** Default: the agent's model, else the runtime's `defaultModel`. */
  readonly model?: ModelRef;
  /** How hard the model thinks. Default: pi-durable's. */
  readonly thinkingLevel?: ModelThinkingLevel;
  /**
   * Tool rounds one run takes at most: the round that reaches it runs its tools, then the run ends without an answer
   * (`turn_limit`). An integer, 1 or more. Default: no limit.
   */
  readonly maxTurns?: number;
  /** The agent's tools the session may use. Default: all of them. */
  readonly tools?: ToolSelection;
  /** Which of the session's calls wait for approval. Default: what the agent's policy gates. */
  readonly requiresApproval?: ApprovalRule;
  /**
   * Idempotency key: creating with the same one again returns the session it made, as it is, whatever the other
   * options say, for as long as that session is not deleted.
   */
  readonly requestId?: string;
}

/**
 * A change to what a session runs with: a field left out keeps its value, `null` puts back the agent's: for `model`,
 * the model a new session gets (the agent's, else the runtime's `defaultModel`); for `thinkingLevel` and `maxTurns`,
 * pi-durable's default.
 */
export interface SessionChange {
  readonly model?: ModelRef | null;
  readonly thinkingLevel?: ModelThinkingLevel | null;
  readonly maxTurns?: number | null;
  readonly tools?: ToolSelection | null;
  readonly requiresApproval?: ApprovalRule | null;
}

/** What a session runs with now. */
export interface SessionSettings {
  readonly model: ModelRef;
  readonly thinkingLevel: ModelThinkingLevel;
  /** Tool rounds one run takes at most; absent, no limit. */
  readonly maxTurns?: number;
  /** The agent's tools the session may use, in the agent's order. */
  readonly tools: readonly string[];
  /** The session's own approval rule; absent, the agent's policy decides. */
  readonly requiresApproval?: ApprovalRule;
}

export interface SubmitInput {
  readonly text: string;
  /** Idempotency key: submitting the same one again returns the first submission. */
  readonly requestId: string;
  /**
   * While a run is going: `queue` (default) waits for the run's answer and starts the next run; `steer` joins the run
   * going on, which reads it after its current tool round; `reject` throws `SessionBusyError`. With no run going, each
   * starts a run.
   */
  readonly whenBusy?: "queue" | "steer" | "reject";
  /**
   * Makes the submission an ask: once the run it starts ends, its answer is delivered to this address through the
   * runtime's `deliverReply`, tried again until it lands. An ask always queues.
   */
  readonly replyTo?: ReplyAddress;
}

export interface SubmitResult {
  readonly submissionId: string;
}

/**
 * What `withdraw` did: `withdrawn` (it was waiting, and it never reaches the agent), `already_placed` (a run took it
 * first), or `settled` (it was answered, withdrawn already, or dropped with its run).
 */
export interface WithdrawResult {
  readonly outcome: "withdrawn" | "already_placed" | "settled";
}

export interface CompactOptions {
  /** What the summary should keep, added to pi-durable's summarization prompt. */
  readonly instructions?: string;
}

export interface EventsOptions {
  /** Resume after this cursor; omitted, the stream replays from its start. */
  readonly from?: Cursor | string;
  /** Ends the iteration. */
  readonly signal?: AbortSignal;
}

/**
 * One session: a pi-durable conversation of an agent instance. A child session, the one a delegate's call runs its
 * sub-agent in, is followed, decided in and aborted like any other, under its sub-agent's tools and policy; only its
 * delegate submits to it, so `submit`, `withdraw`, `configure`, `compact` and `delete` reject with `SessionOwnedError`.
 */
export interface AgentSession {
  readonly id: string;
  /** Admits the input durably and resolves once admitted; the run's progress arrives as events. */
  submit(input: SubmitInput): Promise<SubmitResult>;
  /**
   * Takes back an input still waiting for a run, by the `submissionId` its `submit` gave. Rejects with
   * `InvalidRequestError` for a submission of another session, or one of an ask: its asker waits for its answer.
   */
  withdraw(submissionId: string): Promise<WithdrawResult>;
  /**
   * From `from` (default: the session's start), then live until the instance closes, `signal`
   * aborts or the iteration ends. A reader keeps the session's stream open while it iterates.
   */
  events(options?: EventsOptions): AsyncIterable<StreamItem>;
  /**
   * Decides calls waiting for approval, all in one commit: every decision is applied, or, when any call is not
   * waiting, none is (`ApprovalNotPendingError`). A call a decision reached first is `already_decided`.
   */
  approve(decisions: readonly ApprovalDecision[]): Promise<ApprovalOutcome[]>;
  /**
   * Replies to a deferred call of the session with the token of its reply address: the call returns `text` as its
   * result (an error result with `isError`). A closed instance reopens for it. A second reply to the same call is
   * `already_replied`. Rejects with `ReplyNotPendingError`, changing nothing, for a call that waits for no reply, has
   * ended or passed its deadline, or whose token is another.
   */
  reply(input: ReplyInput): Promise<ReplyResult>;
  /** Stops the run; what it produced so far is kept, ending as aborted. */
  abort(): Promise<void>;
  /**
   * Summarizes the session's older messages into what the model reads from then on; the thread keeps them. Resolves
   * once the compaction is admitted. It runs while the session keeps working, and its summary lands at once when the
   * session is idle, else at the run's next boundary. The stream shows `compaction:start`, then `session:compacted`
   * and `compaction:end`, or `compaction:end` with an `error`.
   */
  compact(options?: CompactOptions): Promise<void>;
  /**
   * Changes which tools the session may use and which of its calls wait for approval, in one commit. A tool change
   * applies from the run's next model request; an approval change to calls that reach the gate after it, while a
   * call already waiting keeps waiting for its decision.
   */
  configure(change: SessionChange): Promise<void>;
  settings(): Promise<SessionSettings>;
  /**
   * Deletes the session and its child sessions: stops its run, ends their readers and hides them at once (their calls
   * reject with `SessionNotFoundError`). The host erases their data once the instance's storage is closed (an idle
   * close, `close()`, or the next close after a crash); a host without `erase` keeps it.
   */
  delete(): Promise<void>;
}

/** One named agent instance: one open Harness over its scope's storage. */
export interface AgentInstance {
  readonly scope: StorageScope;
  readonly agent: AgentDefinition;
  readonly state: InstanceState;
  /**
   * Opens the instance now rather than at first use. Rejects with `LeaseHeldError`. With
   * `closeIdleAfterMs` it may close again once idle; the next call reopens it.
   */
  open(): Promise<void>;
  /** With `requestId`, idempotent: a retry, also after a restart or from another process, returns the first session. */
  createSession(options?: SessionOptions): Promise<SessionInfo>;
  /** Oldest first: one read of the instance's sessions record. A child session is left out; its parent names it. */
  listSessions(): Promise<SessionInfo[]>;
  session(id: string): AgentSession;
  /** For an `alarm` host: its alarm fired, so run what is due and what a lost process left. */
  resume(): Promise<void>;
  /**
   * With `modelsFor`: resolves the instance's models again now, so the next model request of a run
   * already going uses them. Does nothing while the instance is not open (its next open resolves
   * them anyway), nor with a static `models`.
   */
  refreshModels(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRuntimeInspection {
  /** Instances that hold, or are acquiring or releasing, their scope's lease. */
  readonly open: number;
  /** Every instance the runtime holds: those, and those closed for idleness that it reopens for a due sleep. */
  readonly instances: readonly InstanceInspection[];
}

export interface RecoverOptions {
  /** Instances opened at a time; default 4. */
  readonly concurrency?: number;
}

/** What `recover()` did with each scope the host listed. */
export interface RecoverResult {
  /** Opened, so they carry on what they left: a run, a call, a due sleep. */
  readonly opened: readonly StorageScope[];
  /** Another writer holds them, and carries on their work; a crashed one's lease frees them once it expires. */
  readonly held: readonly StorageScope[];
  /** Of an agent kind this runtime does not have. */
  readonly unknown: readonly StorageScope[];
  readonly failed: readonly { readonly scope: StorageScope; readonly error: unknown }[];
}

export interface AgentRuntime {
  /**
   * The instance `name` of `agent`, opened lazily; one per scope per runtime. While the app holds a
   * handle, `get` returns that same handle, also after an idle close.
   */
  get(agent: AgentDefinition | string, name: string): AgentInstance;
  /**
   * Opens every instance the host's `unfinished()` lists, so work a crashed or closed process left (a run, a call, a
   * sleep) carries on without waiting for a call. With `closeIdleAfterMs`, those with nothing to do close again once
   * idle. Run it at startup, and again from time to time where several processes share a storage, to take over the
   * scopes of one that crashed once their leases expire. Throws a `TypeError` for a host without `unfinished`.
   */
  recover(options?: RecoverOptions): Promise<RecoverResult>;
  /** What the runtime holds now. */
  inspect(): AgentRuntimeInspection;
  close(): Promise<void>;
}

const SESSION_ID = /^[1-9]\d{0,15}$/;
/** A submission's id as `submit` hands it out: pi-durable's, a positive integer. */
const SUBMISSION_ID = SESSION_ID;

/** setTimeout's longest delay; a later deadline is reached in steps. */
const MAX_DELAY = 2 ** 31 - 1;

/** One open of an instance: what it holds until it closes. */
interface Opened {
  readonly harness: Harness;
  readonly storage: Storage;
  readonly lease: Lease;
  /** With `modelsFor`: this open's model access. */
  readonly models: ModelAccess | undefined;
  /** Aborted when this open closes, which detaches its listeners from its lease and Harness. */
  readonly detach: AbortController;
  /** The agent's tools as this open registered them, by name: what a session's tool selection names. */
  readonly tools: ReadonlyMap<string, ToolRegistration>;
  /** The task that delivers an ask's reply, as this open registered it. */
  readonly courier: Courier;
  /** The sessions record as this open last read it: what each session's stream reads its approval rule from. */
  sessions: SessionsState | undefined;
  /** Its Harness failed (a storage error), so it reads nothing any more. */
  failed: boolean;
}

/** What an instance needs of the runtime that made it. */
interface RuntimeCore {
  readonly options: AgentRuntimeOptions<unknown>;
  readonly clock: Clock;
  /** How an ask's courier tries again; tests shorten it. */
  courier: CourierTiming;
  /** The instance holds a lease, or acquires or releases one, or waits to reopen for a sleep: the runtime keeps it. */
  hold(instance: Instance): void;
  /** It holds nothing any more. */
  letGo(instance: Instance): void;
}

/** The time every instance of a runtime runs on. */
const systemClock: Clock = {
  now: () => Date.now(),
  timer(callback, ms, keepAlive) {
    const handle = setTimeout(callback, Math.min(Math.max(ms, 0), MAX_DELAY));
    // SAFETY: Node.js timers have `unref`; other runtimes have nothing to unreference.
    if (!keepAlive) (handle as { unref?: () => void }).unref?.();
    return () => clearTimeout(handle);
  },
};

class Instance implements AgentInstance {
  readonly scope: StorageScope;
  readonly agent: AgentDefinition;
  /** The instance's agent and the sub-agents its delegates reach, by kind: what a session's record names. */
  readonly #agents: ReadonlyMap<string, AgentDefinition>;
  readonly #options: AgentRuntimeOptions<unknown>;
  readonly #courierTiming: () => CourierTiming;
  readonly #lifecycle: InstanceLifecycle<Opened>;
  /** The streams of sessions someone needs now; each closes itself once idle and unread. */
  readonly #watches = new Map<ConversationId, SessionWatch>();
  /** Calls under way that can start work (`#armedFor`): while one is, an alarm host is only ever armed `active`. */
  #starting = 0;

  constructor(agent: AgentDefinition, name: string, runtime: RuntimeCore) {
    this.scope = Object.freeze({ kind: agent.kind, name });
    assertScope(this.scope);
    this.agent = agent;
    this.#agents = agentsOf([agent]);
    this.#options = runtime.options;
    this.#courierTiming = () => runtime.courier;
    const { wake } = runtime.options.host;
    this.#lifecycle = new InstanceLifecycle({
      scope: this.scope,
      clock: runtime.clock,
      idleMs: runtime.options.closeIdleAfterMs,
      open: () => this.#open(),
      release: (opened) => this.#release(opened),
      wake: ({ harness }) => harness.wake(),
      arm: wake.kind === "alarm" ? (due) => this.#arm(wake, due) : undefined,
      report: (kind, error) => this.#runtimeReport(kind, error),
      hold: () => runtime.hold(this),
      letGo: () => runtime.letGo(this),
    });
  }

  /** Ended: closed, its lease lost, or its storage failed. It never reopens. */
  get closed(): boolean {
    return this.#lifecycle.ended !== undefined;
  }

  get state(): InstanceState {
    return this.#lifecycle.state;
  }

  /** What the runtime holds for it. Internal: `runtime.inspect()`. */
  inspection(): InstanceInspection {
    return this.#lifecycle.inspection();
  }

  #report(report: InstanceReport) {
    try {
      this.#options.onReport?.(report);
    } catch {
      // A host's report handler that throws must not fail the runtime.
    }
  }

  #runtimeReport(kind: AgentRuntimeReportKind, error: unknown) {
    this.#report({ source: "runtime", scope: this.scope, kind, error });
  }

  /** The ports of one tool call: the runtime's, or what `portsFor` resolves for it. */
  #portsOf = (target: PortsTarget): unknown => {
    const { portsFor } = this.#options;
    return portsFor === undefined ? this.#options.ports : portsFor(target);
  };

  #portsFailed = (target: PortsTarget, error: unknown) => {
    const { sessionId, toolCallId, toolName } = target;
    this.#report({
      source: "runtime",
      scope: this.scope,
      kind: "ports_failed",
      sessionId,
      toolCallId,
      toolName,
      error,
    });
  };

  /**
   * The agent session `conversationId` runs, from its record as this open last read it: the instance's, or a child
   * session's sub-agent. A sub-agent the app no longer defines has no tools.
   */
  #agentOf(opened: Opened, conversationId: ConversationId): AgentDefinition {
    const kind = opened.sessions?.sessions[String(conversationId)]?.agent;
    if (kind === undefined) return this.agent;
    return this.#agents.get(kind) ?? defineAgent({ kind, instructions: "", tools: [] });
  }

  /** What session `conversationId`'s stream knows of a tool: its rule is the one this open last read. */
  #toolInfo(opened: Opened, conversationId: ConversationId): (name: string) => ToolInfo {
    return (name) => {
      const agent = this.#agentOf(opened, conversationId);
      const tool = agent.tool(name);
      return {
        label: tool?.label ?? name,
        tier: tool?.tier ?? UNKNOWN_TIER,
        gated: isGated(agent, name, ruleOf(opened.sessions, conversationId)),
      };
    };
  }

  // ─── Opening and closing ────────────────────────────────────────────────────

  async #open(): Promise<Opened> {
    const { host } = this.#options;
    const lease = await host.lease(this.scope);
    const detach = new AbortController();
    let storage: Storage | undefined;
    let harness: Harness | undefined;
    try {
      if (lease.signal.aborted) throw new InstanceClosedError(this.scope, "lease_lost");
      storage = await host.storage(this.scope, lease);
      // Resolved before anything runs, so work this open resumes runs on the scope's models of now.
      const { modelsFor } = this.#options;
      const models =
        modelsFor === undefined
          ? undefined
          : new ModelAccess(this.scope, modelsFor, (error) => this.#runtimeReport("models_failed", error));
      await models?.refresh();
      const registry = createRegistry();
      const extensions = agentExtensions(this.#agents, {
        scope: this.scope,
        ports: this.#portsOf,
        portsFailed: this.#portsFailed,
      });
      for (const extension of extensions.values()) registry.install(extension);
      // Resolved by name, whichever extensions a conversation selects.
      const { courier, extension: asks } = askCourier({
        deliver: this.#options.deliverReply,
        timing: this.#courierTiming,
        failed: (failure) => this.#report({ source: "runtime", scope: this.scope, kind: "reply_failed", ...failure }),
      });
      registry.install(asks);
      // SAFETY: an instance's agents include its own.
      const own = extensions.get(this.agent.kind)!;
      const tools = new Map((own.tools ?? []).map((tool) => [tool.name, tool]));
      const appSettings = this.#options.settings;
      const telemetry = this.#options.telemetryFor?.(this.scope);
      const { wake } = host;
      harness = await Harness.open(
        storage,
        {
          ...(telemetry !== undefined && { telemetry }),
          // SAFETY: the options hold exactly one of `models` and `modelsFor`.
          models: models?.get ?? (this.#options.models as HarnessOptions["models"]),
          registry,
          // A session that selects no extensions of its own, also one made before sub-agents were, runs its
          // instance's agent alone: no sub-agent's tools or instructions reach it.
          settings: () => ({
            ...(typeof appSettings === "function" ? appSettings() : appSettings),
            extensions: [own],
          }),
          onReport: (report) => this.#report({ source: "pi", scope: this.scope, report }),
          ...(wake.kind === "alarm" && {
            onWake: (state) => {
              // A closed open no longer speaks for the scope: an idle close armed the host itself.
              if (detach.signal.aborted) return;
              this.#arm(wake, state).catch((error: unknown) => this.#runtimeReport("arm_failed", error));
            },
          }),
        },
        context,
      );
      const opened: Opened = {
        harness,
        storage,
        lease,
        models,
        detach,
        tools,
        courier,
        sessions: undefined,
        failed: false,
      };
      // Closed or lost while opening: this open must not write.
      const ended = this.#lifecycle.ended;
      if (ended !== undefined) throw new InstanceClosedError(this.scope, ended);
      // Both listeners belong to this open: an idle close detaches them before it lets the lease go.
      lease.signal.addEventListener("abort", () => void this.#lifecycle.end("lease_lost"), {
        once: true,
        signal: detach.signal,
      });
      void harness.closed.then((end) => {
        if (end.kind !== "failed") return;
        opened.failed = true;
        if (!detach.signal.aborted) void this.#lifecycle.end("failed");
      });
      if (this.#options.closeIdleAfterMs !== undefined) {
        // Every change to the task graph is activity: idleness is measured from the last one.
        await harness.observeTaskGraph({ advance: () => this.#lifecycle.touch(), end: () => undefined }, context);
      }
      // Follow the sessions that have unfinished work before any of it runs again, so their
      // streams carry the resumed work from its first commit.
      const { tasks } = await harness.inspect(context);
      const holds: (() => void)[] = [];
      try {
        const unfinished = new Set(tasks.flatMap((task) => task.record.conversationId ?? []));
        if (unfinished.size > 0) await this.#readSessions(opened);
        for (const id of unfinished) {
          const conversation = await harness.conversation(id, context);
          if (!conversation) continue;
          const watch = this.#watchOf(opened, conversation);
          holds.push(watch.hold());
          await watch.ready;
        }
        if (wake.kind === "alarm") await this.#arm(wake, harness.wake());
        if (lease.signal.aborted) throw new InstanceClosedError(this.scope, "lease_lost");
        // Carry on whatever the last writer of this scope left unfinished, and the sleeps now due.
        harness.resume();
      } finally {
        // A session whose work is under way keeps its stream until the work is done.
        for (const release of holds) release();
      }
      return opened;
    } catch (error) {
      // Whatever was opened is closed before the lease goes, so no two writers ever overlap.
      detach.abort();
      this.#closeWatches();
      if (harness) await harness.close(context).catch(() => undefined);
      else await storage?.close(context).catch(() => undefined);
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Lets go of one open: its listeners, its streams, its Harness, then the deleted sessions the host
   * can erase now that the storage is closed, then its lease, with what the Harness left to do.
   */
  async #release(opened: Opened): Promise<void> {
    const { harness, lease, detach } = opened;
    detach.abort();
    this.#closeWatches();
    const erase = this.#options.host.erase;
    // A failed Harness reads nothing; what it was asked to erase waits for a healthy close.
    const usable = !opened.failed && !lease.signal.aborted;
    const doomed = erase === undefined || !usable ? [] : await this.#toErase(harness);
    let wake: Wake | undefined;
    try {
      wake = harness.wake();
    } catch {
      // A failed Harness throws (`SessionFailed`): released without a wake, the scope counts as unfinished.
    }
    await harness.close(context).catch((error: unknown) => this.#runtimeReport("close_failed", error));
    if (doomed.length > 0 && erase !== undefined && !lease.signal.aborted) {
      await erase
        .call(this.#options.host, this.scope, lease, doomed)
        .catch((error: unknown) => this.#runtimeReport("erase_failed", error));
    }
    await lease.release(wake).catch((error: unknown) => this.#runtimeReport("lease_release_failed", error));
  }

  /**
   * The deleted sessions still in storage. Those an earlier close erased leave the record here, in one commit, so
   * the record holds only what is still to erase.
   */
  async #toErase(harness: Harness): Promise<ConversationId[]> {
    try {
      const erasing = (await harness.snapshot(SessionsDoc, context))?.erasing ?? [];
      if (erasing.length === 0) return [];
      const left: ConversationId[] = [];
      for (const id of erasing) {
        // SAFETY: the record holds ids of conversations the runtime created.
        const conversation = await harness.conversation(id as ConversationId, context);
        if (conversation !== undefined) left.push(conversation.id);
      }
      if (left.length < erasing.length) {
        const kept = new Set<number>(left);
        await harness.commit(async (tx) => {
          const doc = await tx.doc(SessionsDoc);
          doc.erasing = doc.erasing.filter((id) => kept.has(id));
        }, context);
      }
      return left;
    } catch (error) {
      this.#runtimeReport("erase_failed", error);
      return [];
    }
  }

  #closeWatches() {
    for (const watch of [...this.#watches.values()]) watch.close();
    this.#watches.clear();
  }

  /**
   * Arms an alarm host with `wake`, but `active` while a call that can start work is under way. pi-durable reports
   * that call's work only after the commit that starts it, so an idle wake armed before then, by another call done
   * meanwhile or by pi-durable as another run ends, would leave committed work that nothing wakes.
   */
  #arm(alarm: Extract<HostWake, { kind: "alarm" }>, wake: Wake): Promise<void> {
    return alarm.arm(this.scope, this.#starting > 0 ? { ...wake, active: true } : wake);
  }

  /**
   * Runs a call that can start work with an alarm host armed for it: `active` from before the call until it is done,
   * so a process that dies while the call starts work is woken, and then with what is due, since pi-durable reports
   * only a change to its wake and a call that started nothing changes none. Of calls that overlap, the last one done
   * arms what is due. A failure to arm after the call is reported; the call stands.
   */
  async #armedFor<R>(harness: Harness, call: () => Promise<R>): Promise<R> {
    const { wake } = this.#options.host;
    if (wake.kind !== "alarm") return call();
    // Counted from before its own arm, so nothing armed meanwhile can say idle.
    this.#starting += 1;
    let armed = false;
    try {
      await this.#arm(wake, { ...harness.wake(), active: true });
      armed = true;
      return await call();
    } finally {
      this.#starting -= 1;
      let due: Wake | undefined;
      try {
        due = armed ? harness.wake() : undefined;
      } catch {
        // A failed Harness throws (`SessionFailed`): its scope stays armed active, so it is woken to recover.
      }
      if (due !== undefined) {
        await this.#arm(wake, due).catch((error: unknown) => this.#runtimeReport("arm_failed", error));
      }
    }
  }

  /** The session's stream, opened if nobody needed it until now. */
  #watchOf(opened: Opened, conversation: Conversation): SessionWatch {
    const existing = this.#watches.get(conversation.id);
    if (existing) return existing;
    const watch = new SessionWatch({
      harness: opened.harness,
      storage: opened.storage,
      conversation,
      info: this.#toolInfo(opened, conversation.id),
      report: (error) => this.#runtimeReport("listener_error", error),
      onClose: (closed) => {
        if (this.#watches.get(conversation.id) === closed) this.#watches.delete(conversation.id);
      },
    });
    this.#watches.set(conversation.id, watch);
    // A failed start closes the watch; whoever awaits `ready` sees the error.
    watch.ready.catch(() => undefined);
    return watch;
  }

  /** Runs `work` with the session's stream held open, so every commit `work` causes reaches it. */
  async #withWatch<T>(opened: Opened, conversation: Conversation, work: () => Promise<T>): Promise<T> {
    const watch = this.#watchOf(opened, conversation);
    const release = watch.hold();
    try {
      await watch.ready;
      return await work();
    } finally {
      release();
    }
  }

  /** What the instance holds for its sessions' streams. Internal: for the bounded-memory tests. */
  heldStreams(): { readonly sessions: number; readonly events: number; readonly readers: number } {
    let events = 0;
    let readers = 0;
    for (const watch of this.#watches.values()) {
      events += watch.held.events;
      readers += watch.held.readers;
    }
    return { sessions: this.#watches.size, events, readers };
  }

  /** The sessions record as it is now, kept on the open for the sessions' streams. */
  async #readSessions(opened: Opened): Promise<SessionsState | undefined> {
    opened.sessions = await opened.harness.snapshot(SessionsDoc, context);
    return opened.sessions;
  }

  /**
   * The conversation of a session the sessions record lists, a child session included: not one a task made that the
   * runtime does not run as a session, nor one deleted.
   */
  async #conversation(opened: Opened, sessionId: string): Promise<Conversation> {
    const sessions = await this.#readSessions(opened);
    // SAFETY: the brand only marks pi-durable's ids; looking the id up checks that it names one.
    const conversation =
      SESSION_ID.test(sessionId) && sessions?.sessions[sessionId] !== undefined
        ? await opened.harness.conversation(Number(sessionId) as ConversationId, context)
        : undefined;
    if (!conversation) throw new SessionNotFoundError(sessionId);
    return conversation;
  }

  /** Refuses what only a session of the app's may take: a child session is its delegate's call's to submit to. */
  #refuseOwned(opened: Opened, sessionId: string) {
    if (opened.sessions?.sessions[sessionId]?.parent !== undefined) throw new SessionOwnedError(sessionId);
  }

  /** pi-durable's change of the agent's tools for `selection` (`null`: all of them again). */
  #toolsChange(opened: Opened, names: readonly string[] | null): Pick<AgentChange, "tools"> {
    if (names === null) return { tools: null };
    // SAFETY: the names were checked against the agent's tools, and the open registered every one.
    return { tools: names.map((name) => opened.tools.get(name)!) };
  }

  open(): Promise<void> {
    return this.#lifecycle.run(async () => undefined);
  }

  /** The model a session runs with: `requested`, else the agent's, else the runtime's default. */
  #modelOf(requested: ModelRef | undefined): ModelRef {
    const model = requested ?? this.agent.model ?? this.#options.defaultModel;
    if (model === undefined) {
      throw new TypeError(
        `No model for a session of \`${this.agent.kind}\`: pass one, or set the agent's or the runtime's default`,
      );
    }
    return { provider: model.provider, modelId: model.modelId };
  }

  createSession(options?: SessionOptions): Promise<SessionInfo> {
    let model: ModelRef;
    let tools: string[] | undefined;
    let rule: ReturnType<typeof storedRule> | undefined;
    try {
      model = this.#modelOf(options?.model);
      if (options?.tools !== undefined) tools = selectedTools(this.agent, options.tools);
      if (options?.requiresApproval !== undefined) rule = storedRule(this.agent, options.requiresApproval);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = options?.requestId;
    return this.#lifecycle.run(async (opened) => {
      // One commit looks the request up and makes the session it does not find, so no retry, however it overlaps or
      // whatever crash came before it, makes a second one.
      const session = await opened.harness.commit(async (tx): Promise<SessionInfo> => {
        const doc = await tx.doc(SessionsDoc);
        if (requestId !== undefined) {
          for (const [id, record] of Object.entries(doc.sessions)) {
            if (record.requestId === requestId) return { id, createdAt: record.createdAt };
          }
        }
        const createdAt = Date.now();
        const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
        // pi-durable refuses a `maxTurns` that is not an integer 1 or more with a `RangeError`, failing the commit.
        await configure(tx, id, {
          model,
          ...(options?.thinkingLevel !== undefined && { thinkingLevel: options.thinkingLevel }),
          ...(options?.maxTurns !== undefined && { maxTurns: options.maxTurns }),
          ...(tools !== undefined && this.#toolsChange(opened, tools)),
        });
        doc.sessions[String(id)] = {
          createdAt,
          ...(rule !== undefined && { requiresApproval: rule }),
          ...(requestId !== undefined && { requestId }),
        };
        return { id: String(id), createdAt };
      }, context);
      await this.#readSessions(opened);
      return session;
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.#lifecycle.run(async (opened) => {
      const sessions = (await this.#readSessions(opened))?.sessions ?? {};
      return Object.entries(sessions)
        .flatMap(([id, { createdAt, parent }]) => (parent === undefined ? [{ id, createdAt }] : []))
        .sort((a, b) => Number(a.id) - Number(b.id));
    });
  }

  session(id: string): AgentSession {
    return new Session(this, id);
  }

  resume(): Promise<void> {
    return this.#lifecycle.run(async ({ harness, models }) => {
      await models?.refresh();
      await this.#armedFor(harness, async () => harness.resume());
    });
  }

  async refreshModels(): Promise<void> {
    await this.#lifecycle.opened?.models?.refresh();
  }

  async close(): Promise<void> {
    await this.#lifecycle.end("closed");
  }

  // ─── Session operations ─────────────────────────────────────────────────────

  submit(sessionId: string, input: SubmitInput): Promise<SubmitResult> {
    const { replyTo } = input;
    if (replyTo !== undefined) {
      const refused = this.#refusedAsk(input);
      if (refused !== undefined) return Promise.reject(new InvalidRequestError(refused));
    }
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      this.#refuseOwned(opened, sessionId);
      return this.#withWatch(opened, conversation, async () => {
        // The run this input starts uses the scope's models of now.
        await opened.models?.refresh();
        return this.#armedFor(harness, async () => {
          if (replyTo !== undefined) {
            const { text, requestId } = input;
            return {
              submissionId: String(await ask(harness, conversation, opened.courier, { text, requestId, replyTo })),
            };
          }
          try {
            // pi's `followUp`, its default, is what `queue` asks for; a steer to an idle session starts a run.
            const submission = await conversation.submit(
              {
                type: "input",
                content: input.text,
                requestId: input.requestId,
                ...(input.whenBusy === "steer" && { whenBusy: "steer" as const, entry: { kind: STEER_ENTRY } }),
                ...(input.whenBusy === "reject" && { whenBusy: "reject" as const }),
              },
              context,
            );
            return { submissionId: String(submission.id) };
          } catch (error) {
            throw error instanceof ConversationBusy ? new SessionBusyError(sessionId) : error;
          }
        });
      });
    });
  }

  /** Why `submit` refuses an ask, if it does. */
  #refusedAsk(input: SubmitInput): string | undefined {
    if (this.#options.deliverReply === undefined)
      return "This runtime cannot reply to an ask: it has no `deliverReply`";
    if (input.whenBusy === "reject") return 'An ask always queues: `replyTo` takes no `whenBusy: "reject"`';
    // Its answer is the answer of a run of its own, which a steer, joining another's, never has.
    if (input.whenBusy === "steer") return 'An ask always queues: `replyTo` takes no `whenBusy: "steer"`';
    if (!replyAddressSchema.safeParse(input.replyTo).success) return "`replyTo` is not a reply address";
    return undefined;
  }

  /** A reader keeps the instance open from its first step until it ends. */
  events(sessionId: string, options: EventsOptions | undefined): AsyncGenerator<StreamItem, void, undefined> {
    return this.#lifecycle.read((opened) => this.#stream(opened, sessionId, options));
  }

  async *#stream(opened: Opened, sessionId: string, options: EventsOptions | undefined) {
    const conversation = await this.#conversation(opened, sessionId);
    // `read` holds the watch from its first step, which runs before anything here can await.
    yield* this.#watchOf(opened, conversation).read(options?.from, options?.signal);
  }

  approve(sessionId: string, decisions: readonly ApprovalDecision[]): Promise<ApprovalOutcome[]> {
    return this.#lifecycle.run(async (opened) => {
      // A closed instance reopens here: the parked call is committed state, so the decision finds it.
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      return this.#withWatch(opened, conversation, async () => {
        await opened.models?.refresh();
        const rule = ruleOf(opened.sessions, conversation.id);
        const agent = this.#agentOf(opened, conversation.id);
        return this.#armedFor(harness, () => decide(agent, harness, conversation.id, rule, decisions));
      });
    });
  }

  reply(sessionId: string, input: ReplyInput): Promise<ReplyResult> {
    return this.#lifecycle.run(async (opened) => {
      // A closed instance reopens here: the parked call is committed state, so the reply finds it. A child session's
      // calls take replies too, since a sub-agent may make a deferred call.
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      return this.#withWatch(opened, conversation, () =>
        this.#armedFor(harness, () => applyReply(harness, conversation.id, input)),
      );
    });
  }

  abort(sessionId: string): Promise<void> {
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      await this.#withWatch(opened, conversation, () => this.#armedFor(harness, () => conversation.abort(context)));
    });
  }

  compact(sessionId: string, options: CompactOptions | undefined): Promise<void> {
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      // A child's context is its delegate's call's work: the app compacts the sessions it made.
      this.#refuseOwned(opened, sessionId);
      await this.#withWatch(opened, conversation, async () => {
        // The summary is a model request, made on the scope's models of now.
        await opened.models?.refresh();
        await this.#armedFor(harness, () => conversation.compact(options?.instructions, context));
      });
    });
  }

  withdraw(sessionId: string, submissionId: string): Promise<WithdrawResult> {
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      this.#refuseOwned(opened, sessionId);
      // SAFETY: the brand only marks pi-durable's ids; reading the record checks that it names one of this session's.
      const id = SUBMISSION_ID.test(submissionId) ? (Number(submissionId) as SubmissionId) : undefined;
      const record = id === undefined ? undefined : await (await harness.submission(id, context))?.status(context);
      if (id === undefined || record?.type !== "input" || record.conversationId !== conversation.id) {
        throw new InvalidRequestError(`Session ${sessionId} has no input ${submissionId}`);
      }
      if (record.notify !== undefined) {
        throw new InvalidRequestError(`Input ${submissionId} is an ask: its asker waits for its answer`);
      }
      // Taking an input back starts no work, so nothing needs a wake-up; the stream shows it leave the queue.
      const outcome = await this.#withWatch(opened, conversation, () =>
        harness.abortSubmission(id, context, conversation.id),
      );
      switch (outcome) {
        case "aborted":
          return { outcome: "withdrawn" };
        case "not_found":
          throw new InvalidRequestError(`Session ${sessionId} has no input ${submissionId}`);
        default:
          return { outcome };
      }
    });
  }

  configure(sessionId: string, change: SessionChange): Promise<void> {
    let model: ModelRef | undefined;
    let tools: string[] | null | undefined;
    let rule: ReturnType<typeof storedRule> | null | undefined;
    try {
      // pi-durable's unset model would leave the session with none, so `null` puts back the one a new session gets.
      if (change.model !== undefined) model = this.#modelOf(change.model ?? undefined);
      if (change.tools !== undefined) tools = change.tools === null ? null : selectedTools(this.agent, change.tools);
      if (change.requiresApproval !== undefined) {
        rule = change.requiresApproval === null ? null : storedRule(this.agent, change.requiresApproval);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      this.#refuseOwned(opened, sessionId);
      const agentChange: AgentChange = {
        ...(model !== undefined && { model }),
        ...(change.thinkingLevel !== undefined && { thinkingLevel: change.thinkingLevel }),
        ...(change.maxTurns !== undefined && { maxTurns: change.maxTurns }),
        ...(tools !== undefined && this.#toolsChange(opened, tools)),
      };
      const agentChanges = Object.keys(agentChange).length > 0;
      if (!agentChanges && rule === undefined) return;
      // One commit: pi-durable's `RangeError` for a bad `maxTurns` discards the whole change.
      await harness.commit(async (tx) => {
        if (agentChanges) await configure(tx, conversation.id, agentChange);
        if (rule === undefined) return;
        const record = (await tx.doc(SessionsDoc)).sessions[sessionId];
        if (record === undefined) throw new SessionNotFoundError(sessionId);
        if (rule === null) delete record.requiresApproval;
        else record.requiresApproval = rule;
      }, context);
      await this.#readSessions(opened);
    });
  }

  settings(sessionId: string): Promise<SessionSettings> {
    return this.#lifecycle.run(async (opened) => {
      const conversation = await this.#conversation(opened, sessionId);
      const agent = await conversation.agent(context);
      // Every session gets a model when it is made, and `configure` never takes it away.
      if (agent.model === undefined) throw new Error(`Session ${sessionId} has no model`);
      const offered = new Set(agent.tools.map((tool) => tool.name));
      const rule = ruleOf(opened.sessions, conversation.id);
      return {
        model: { provider: agent.model.provider, modelId: agent.model.modelId },
        thinkingLevel: agent.thinkingLevel,
        ...(agent.maxTurns !== undefined && { maxTurns: agent.maxTurns }),
        tools: this.#agentOf(opened, conversation.id)
          .tools.map((tool) => tool.name)
          .filter((name) => offered.has(name)),
        ...(rule !== undefined && { requiresApproval: rule }),
      };
    });
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      this.#refuseOwned(opened, sessionId);
      // Stopping the run can run its abort handlers: work an alarm host must be woken for. It stops the session's
      // delegate calls, and with them their child sessions' runs.
      await this.#armedFor(harness, () => conversation.abort(context, { background: true }));
      // Its child sessions go with it, in the same commit.
      const deleted = await harness.commit(async (tx) => {
        const doc = await tx.doc(SessionsDoc);
        const ids = withChildren(doc.sessions, sessionId).map(Number);
        const erasing = new Set(doc.erasing);
        for (const id of ids) {
          delete doc.sessions[String(id)];
          if (!erasing.has(id)) doc.erasing.push(id);
        }
        return ids;
      }, context);
      await this.#readSessions(opened);
      // Their readers end; a reader that comes back finds no session.
      // SAFETY: the record holds ids of conversations the runtime created.
      for (const id of deleted) this.#watches.get(id as ConversationId)?.close();
    });
  }
}

class Session implements AgentSession {
  readonly #instance: Instance;
  readonly id: string;

  constructor(instance: Instance, id: string) {
    this.#instance = instance;
    this.id = id;
  }

  submit(input: SubmitInput): Promise<SubmitResult> {
    return this.#instance.submit(this.id, input);
  }

  events(options?: EventsOptions): AsyncIterable<StreamItem> {
    return { [Symbol.asyncIterator]: () => this.#instance.events(this.id, options) };
  }

  approve(decisions: readonly ApprovalDecision[]): Promise<ApprovalOutcome[]> {
    return this.#instance.approve(this.id, decisions);
  }

  reply(input: ReplyInput): Promise<ReplyResult> {
    return this.#instance.reply(this.id, input);
  }

  abort(): Promise<void> {
    return this.#instance.abort(this.id);
  }

  compact(options?: CompactOptions): Promise<void> {
    return this.#instance.compact(this.id, options);
  }

  withdraw(submissionId: string): Promise<WithdrawResult> {
    return this.#instance.withdraw(this.id, submissionId);
  }

  configure(change: SessionChange): Promise<void> {
    return this.#instance.configure(this.id, change);
  }

  settings(): Promise<SessionSettings> {
    return this.#instance.settings(this.id);
  }

  delete(): Promise<void> {
    return this.#instance.deleteSession(this.id);
  }
}

/**
 * The runtime: agent definitions bound to a host, model access and the app's ports. Each named
 * instance of an agent is one pi-durable Harness over the storage the host opens for its scope,
 * opened at first use and held under the host's single-writer lease until it closes: by `close()`,
 * a lost lease, a failed storage, or, with `closeIdleAfterMs`, once idle, after which its next call
 * opens it again.
 */
export function createAgentRuntime<Ports>(options: AgentRuntimeOptions<Ports>): AgentRuntime {
  const agents = new Map<string, AgentDefinition>();
  for (const agent of options.agents) {
    if (agents.has(agent.kind)) throw new TypeError(`Two agents of kind \`${agent.kind}\``);
    agents.set(agent.kind, agent);
  }
  // One definition per kind across every agent and the sub-agents their delegates reach.
  agentsOf(options.agents);
  if ((options.models === undefined) === (options.modelsFor === undefined)) {
    throw new TypeError("Pass exactly one of `models` and `modelsFor`");
  }
  if (("ports" in options && options.ports !== undefined) === (options.portsFor !== undefined)) {
    throw new TypeError("Pass exactly one of `ports` and `portsFor`");
  }
  const idle = options.closeIdleAfterMs;
  if (idle !== undefined && !(Number.isFinite(idle) && idle > 0)) {
    throw new TypeError("`closeIdleAfterMs` must be a positive number of milliseconds");
  }
  let closed = false;
  // A handle the app holds stays the instance of its scope, also once closed for idleness; one
  // nobody holds any more is collected. The runtime holds only those that hold something.
  const instances = new Map<string, WeakRef<Instance>>();
  const collected = new FinalizationRegistry<string>((key) => {
    if (instances.get(key)?.deref() === undefined) instances.delete(key);
  });
  const held = new Set<Instance>();
  const core: RuntimeCore = {
    options: options as AgentRuntimeOptions<unknown>,
    clock: systemClock,
    courier: COURIER_TIMING,
    hold: (instance) => void held.add(instance),
    letGo: (instance) => void held.delete(instance),
  };

  const runtime: AgentRuntime = {
    get(agent, name) {
      if (closed) throw new TypeError("The runtime is closed");
      const kind = typeof agent === "string" ? agent : agent.kind;
      const definition = agents.get(kind);
      if (!definition || (typeof agent !== "string" && agent !== definition)) {
        throw new TypeError(`Agent \`${kind}\` is not one of this runtime's agents`);
      }
      const key = scopeKey({ kind, name });
      let instance = instances.get(key)?.deref();
      if (!instance || instance.closed) {
        instance = new Instance(definition, name, core);
        instances.set(key, new WeakRef(instance));
        collected.register(instance, key);
      }
      return instance;
    },
    async recover(recoverOptions) {
      const { host } = options;
      if (host.unfinished === undefined) throw new TypeError("The host cannot list scopes with unfinished work");
      const concurrency = recoverOptions?.concurrency ?? 4;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new TypeError("`concurrency` must be a positive integer");
      }
      const result = { opened: [] as StorageScope[], held: [] as StorageScope[], unknown: [] as StorageScope[] };
      const failed: { scope: StorageScope; error: unknown }[] = [];
      // Workers share one iterator: an async generator queues their calls of `next()`.
      const scopes = host.unfinished()[Symbol.asyncIterator]();
      const work = async () => {
        for (;;) {
          const next = await scopes.next();
          if (next.done === true || closed) return;
          const scope = next.value;
          if (!agents.has(scope.kind)) {
            result.unknown.push(scope);
            continue;
          }
          try {
            // Opening carries on what the scope left; an instance already open here has nothing to recover.
            await runtime.get(scope.kind, scope.name).open();
            result.opened.push(scope);
          } catch (error) {
            if (error instanceof LeaseHeldError) result.held.push(scope);
            else failed.push({ scope, error });
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, work));
      return { ...result, failed };
    },
    inspect() {
      const all = [...held].map((instance) => instance.inspection());
      const open = all.filter(({ state }) => state === "opening" || state === "open" || state === "closing").length;
      return { open, instances: all };
    },
    async close() {
      closed = true;
      const all = new Set(held);
      for (const ref of instances.values()) {
        const instance = ref.deref();
        if (instance) all.add(instance);
      }
      await Promise.all([...all].map((instance) => instance.close()));
      instances.clear();
      held.clear();
    },
  };
  cores.set(runtime, core);
  return runtime;
}

const cores = new WeakMap<AgentRuntime, RuntimeCore>();

/** Shortens how a runtime's ask couriers try again, so a test does not wait them out. Internal: not exported. */
export function setCourierTimingForTests(runtime: AgentRuntime, timing: Partial<CourierTiming>): void {
  const core = cores.get(runtime);
  if (core === undefined) throw new TypeError("Not a runtime made by createAgentRuntime");
  core.courier = { ...core.courier, ...timing };
}

/** What an instance holds for its sessions' streams. Internal, not exported by the package: for tests. */
export function heldStreams(instance: AgentInstance): ReturnType<Instance["heldStreams"]> {
  if (!(instance instanceof Instance)) throw new TypeError("Not an instance made by createAgentRuntime");
  return instance.heldStreams();
}
