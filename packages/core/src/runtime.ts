import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isJsonValue } from "@earendil-works/chord/json";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { configure, ConversationBusy, createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  BlockedReason,
  Conversation,
  ConversationId,
  HarnessOptions,
  JsonObject,
  ModelRef,
  Registry,
  Report,
  Storage,
  SubmissionId,
  TaskGraph,
  TaskId,
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
import { appExtensions } from "./engine/extensions.ts";
import type { AppExtensions, ExtensionsResolver } from "./engine/extensions.ts";
import { inputEntry } from "./engine/inputs.ts";
import { InstanceLifecycle } from "./engine/lifecycle.ts";
import type { Clock, InstanceInspection, InstanceState } from "./engine/lifecycle.ts";
import { ModelAccess } from "./engine/models.ts";
import type { ModelsResolver } from "./engine/models.ts";
import { applyReply } from "./engine/replies.ts";
import type { ReplyInput, ReplyResult } from "./engine/replies.ts";
import { selectedTools, SessionsDoc, storedRule, withChildren } from "./engine/sessions.ts";
import type { ApprovalRule, SessionRecord, ToolSelection } from "./engine/sessions.ts";
import { ContinueEntry } from "./engine/transcriber.ts";
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
import { idFromNumber } from "./ids.ts";
import type { PortsResolver, PortsTarget } from "./tool.ts";

const context = BACKGROUND_CONTEXT;

interface SessionsState {
  readonly sessions: Readonly<Record<string, Readonly<SessionRecord>>>;
  readonly erasing: readonly number[];
}

/**
 * Why the runtime itself reports: a session's commit it could not turn into events, a failed cleanup or host call,
 * `modelsFor` failing for an instance, a reopen for a due sleep that failed, or the host failing to erase deleted
 * sessions, which the runtime tries again at the instance's next close.
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
 * A failure about one instance that fails no call of the app's. `source: "pi"` carries pi-durable's report exactly as
 * `HarnessOptions.onReport` received it, and `source: "runtime"` is the runtime's own. `ports_failed` names the tool
 * call whose ports `portsFor` could not resolve, and that call ended with an error result. `reply_failed` names an ask
 * of the instance whose reply `deliverReply` failed to deliver, or whose request was first submitted without a reply
 * address. A failed delivery is tried again unless `gaveUp`. `task_blocked` names a task of a session that cannot run
 * on this open. Either no extension provides its definition, as `missing_task`, or the one that does cannot take over
 * its state, as `task_too_old` or `migration_failed`. The task keeps its session busy until an open provides the
 * definition again or the session is aborted. Each open reports a task once, whether it is blocked when the instance
 * opens or becomes blocked later.
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
  | {
      readonly source: "runtime";
      readonly scope: StorageScope;
      readonly kind: "task_blocked";
      readonly sessionId: string;
      readonly taskKind: string;
      readonly reason: BlockedReason;
    }
  | ({ readonly source: "runtime"; readonly scope: StorageScope; readonly kind: "reply_failed" } & ReplyFailure);

interface AgentRuntimeCommonOptions<Ports> {
  readonly agents: readonly AgentDefinition<Ports>[];
  readonly host: AgentHost;
  /** The model of a new session that names none and whose agent names none. */
  readonly defaultModel?: ModelRef;
  /**
   * Failures that fail no call. They are the runtime's own and pi-durable's reports, such as a tool task that faulted
   * or a storage failure.
   */
  readonly onReport?: (report: InstanceReport) => void;
  /**
   * Closes an instance once it has been idle this long, in ms. Its Harness closes, its lease is released and the
   * runtime lets it go. Any handle the app still holds reopens it at its next call. Idle means no call of the runtime's
   * under way on it, no event reader attached, no task that can run now or is running, and no sleep due within this
   * time. By default an instance stays open until `close()`.
   */
  readonly closeIdleAfterMs?: number;
  /**
   * How long a nested call waits at the approval gate for a decision, in ms, from when it first parks. A nested call
   * is one a tool makes through pi-durable's `executeTool()`, such as a call from a code mode script. The tool that
   * made it awaits it, so its invocation runs and the instance does not close idle meanwhile. With no decision by
   * then, the nested call fails for that tool with `No decision arrived in time.` A call of the model's holds no
   * process while it waits, and waits until it is decided. It defaults to an hour.
   */
  readonly nestedApprovalTimeoutMs?: number;
  /**
   * pi-durable's `HarnessOptions.settings`, such as `progress`, passed to every instance's Harness. pi-durable reads
   * them at each use. The runtime sets `extensions` itself, because a session selects the app's extensions and its own
   * agent's.
   */
  readonly settings?: HarnessOptions["settings"];
  /**
   * The app's pi-durable extensions for one instance, from its scope. They hold tools, prompt sections, hooks and tasks
   * that use the app's resources. The runtime calls it each time the instance opens, before anything of it runs, and on
   * `refreshExtensions()`. A throw or rejection fails the open, or fails the refresh, which then changes nothing. Each
   * extension's tools carry the tiers its `tier` gives them. Its `agents` say which agents' sessions select it, and by
   * default only the instance's own agent's sessions do. By default there are no app extensions.
   */
  readonly extensionsFor?: ExtensionsResolver;
  /**
   * The telemetry of one instance, from its scope. It is pi-durable's `HarnessOptions.telemetry`, a pi-telemetry
   * `TelemetryContext` that receives the instance's content-free `pi.durable.*` spans and metrics. The runtime calls it
   * each time the instance opens. It defaults to pi-durable's, which records nothing.
   */
  readonly telemetryFor?: (scope: StorageScope) => NonNullable<HarnessOptions["telemetry"]>;
  /**
   * The execution environment of one instance, from its scope. It is pi-durable's `HarnessOptions.env`, which builds
   * the `ExecutionEnv` a tool call reads as `api.env`. pi-durable's `bash` runs in its `cwd`. The runtime calls it each
   * time the instance opens. By default there is none, so a tool that needs an environment fails its call.
   */
  readonly envFor?: (scope: StorageScope) => NonNullable<HarnessOptions["env"]>;
  /**
   * How the runtime reaches a reply address. When an ask's run ends, its answer goes to the asker's instance through
   * the app's way to reach that instance's home, such as the local runtime's `session.reply`, a client of the cluster
   * or a Durable Object's stub. Resolve once the reply was delivered or refused for good, and map `reply_not_pending`
   * and `session_not_found` to resolving. Reject to have it tried again later. Without it, `submit` refuses `replyTo`.
   */
  readonly deliverReply?: DeliverReply;
}

/**
 * Model access, either one `models` for every instance or `modelsFor`, resolved per instance from its scope so each
 * instance runs on its own caller's credentials.
 */
export type AgentRuntimeModelsOption =
  | {
      /** pi-ai model access for every instance, passed to pi-durable's `HarnessOptions.models` as is. */
      readonly models: HarnessOptions["models"];
      readonly modelsFor?: never;
    }
  | {
      /**
       * The model access of one instance, from its scope, which is what `models` would be for it. It may be async. The
       * runtime resolves it when the instance opens, also when it reopens after a restart or an idle close. It resolves
       * it again before every `submit`, `approve` and `resume`, and on `refreshModels()`. pi-durable reads the newest
       * result at each model request. A throw or rejection is reported as `models_failed`, and every model request
       * fails with `ModelsUnavailableError` until a later resolution succeeds.
       */
      readonly modelsFor: ModelsResolver;
      readonly models?: never;
    };

/** Ports, either one object for every tool call or `portsFor`, resolved for each call from where it runs. */
export type AgentRuntimePortsOption<Ports> =
  | {
      /** Handed to every tool call as `context.ports`. */
      readonly ports: Ports;
      readonly portsFor?: never;
    }
  | {
      /**
       * The ports of one tool call, from its scope and session. The runtime resolves them right before the call
       * executes, after its approval, and again for a call that a restart reruns. It may be async. A failure fails
       * that call alone and is reported as `ports_failed`.
       */
      readonly portsFor: PortsResolver<Ports>;
      readonly ports?: never;
    };

export type AgentRuntimeOptions<Ports> = AgentRuntimeCommonOptions<Ports> &
  AgentRuntimeModelsOption &
  AgentRuntimePortsOption<Ports>;

export interface SessionInfo {
  readonly id: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
}

export interface SessionOptions {
  /** It defaults to the agent's model, else the runtime's `defaultModel`. */
  readonly model?: ModelRef;
  /** How hard the model thinks. It defaults to pi-durable's level. */
  readonly thinkingLevel?: ModelThinkingLevel;
  /**
   * The most tool rounds one run takes. The round that reaches it runs its tools, then the run ends without an answer
   * as `turn_limit`. It is an integer of 1 or more. By default there is no limit.
   */
  readonly maxTurns?: number;
  /** The agent's tools the session may use. By default it may use all of them. */
  readonly tools?: ToolSelection;
  /** Which of the session's calls wait for approval. By default the agent's policy decides. */
  readonly requiresApproval?: ApprovalRule;
  /**
   * An idempotency key. Creating with the same one again returns the session it made, as it is, whatever the other
   * options say, for as long as that session is not deleted.
   */
  readonly requestId?: string;
}

/**
 * A change to what a session runs with. A field left out keeps its value, and `null` puts back the agent's. For
 * `model`, `null` puts back the model a new session gets, which is the agent's or else the runtime's `defaultModel`.
 * For `thinkingLevel` and `maxTurns`, it puts back pi-durable's default.
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
  /** The most tool rounds one run takes. When absent, there is no limit. */
  readonly maxTurns?: number;
  /** The agent's tools the session may use, in the agent's order. */
  readonly tools: readonly string[];
  /** The session's own approval rule. When absent, the agent's policy decides. */
  readonly requiresApproval?: ApprovalRule;
}

export interface SubmitInput {
  readonly text: string;
  /** An idempotency key. Submitting the same one again returns the first submission. */
  readonly requestId: string;
  /**
   * What the input does while a run is going. `queue`, the default, waits for the run's answer and starts the next run.
   * `steer` joins the run going on, which reads it after its current tool round. `reject` throws `SessionBusyError`.
   * With no run going, each starts a run.
   */
  readonly whenBusy?: "queue" | "steer" | "reject";
  /**
   * Makes the submission an ask. Once the run it starts ends, the runtime's `deliverReply` delivers its answer to this
   * address, and tries again until the delivery succeeds. An ask always queues.
   */
  readonly replyTo?: ReplyAddress;
  /**
   * Stored as it is on the input's entry, for the app's hooks to read back with `runInputs`. A `beforeRequest` hook may
   * read it to put context after the input in each request. It is a JSON object, and an ask takes none.
   */
  readonly metadata?: JsonObject;
}

export interface SubmitResult {
  readonly submissionId: string;
}

export interface ContinueInput {
  /** An idempotency key. Continuing with the same one again returns the first continue. */
  readonly requestId: string;
}

/**
 * What `withdraw` did. `withdrawn` means the input was waiting and never reaches the agent. `already_placed` means a
 * run took it first. `settled` means it was answered, withdrawn already, or dropped with its run.
 */
export interface WithdrawResult {
  readonly outcome: "withdrawn" | "already_placed" | "settled";
}

export interface CompactOptions {
  /** What the summary should keep, added to pi-durable's summarization prompt. */
  readonly instructions?: string;
}

export interface EventsOptions {
  /** Resume after this cursor. When omitted, the stream replays from its start. */
  readonly from?: Cursor | string;
  /** Ends the iteration. */
  readonly signal?: AbortSignal;
}

/**
 * One session, a pi-durable conversation of an instance. A child session is the one a delegate's call runs its
 * sub-agent in. It is followed, decided in and aborted like any other, under its sub-agent's tools and policy. Only its
 * delegate submits to it, so `submit`, `continue`, `withdraw`, `configure`, `compact` and `delete` reject with
 * `SessionOwnedError`.
 */
export interface AgentSession {
  readonly id: string;
  /** Admits the input durably and resolves once admitted. The run's progress arrives as events. */
  submit(input: SubmitInput): Promise<SubmitResult>;
  /**
   * Starts a run on the session's context as it is, without a new message. It carries on a run that ended without an
   * answer, such as one that reached its turn limit, from where it stopped. Inputs a failed run left waiting join it.
   * It works only while no run is going, and a busy session rejects with `SessionBusyError`. A context that ends with
   * an answer has nothing to answer, so the run ends at once as `nothing_to_answer`. It resolves once admitted, as
   * `submit` does.
   */
  continue(input: ContinueInput): Promise<SubmitResult>;
  /**
   * Takes back an input still waiting for a run, by the `submissionId` its `submit` gave. Rejects with
   * `InvalidRequestError` for a submission of another session, or for one of an ask, whose asker waits for its answer.
   */
  withdraw(submissionId: string): Promise<WithdrawResult>;
  /**
   * The session's events from `from`, or from the session's start by default, then live until the instance closes,
   * `signal` aborts or the iteration ends. A reader keeps the session's stream open while it iterates.
   */
  events(options?: EventsOptions): AsyncIterable<StreamItem>;
  /**
   * Decides calls waiting for approval, all in one commit. Every decision is applied, or none is when any call is not
   * waiting, and then it rejects with `ApprovalNotPendingError`. A call that a decision reached first is
   * `already_decided`.
   */
  approve(decisions: readonly ApprovalDecision[]): Promise<ApprovalOutcome[]>;
  /**
   * Replies to a deferred call of the session with the token of its reply address. The call returns `text` as its
   * result, or as an error result with `isError`. A closed instance reopens for it. A second reply to the same call is
   * `already_replied`. Rejects with `ReplyNotPendingError`, changing nothing, for a call that waits for no reply, has
   * ended or passed its deadline, or whose token is another.
   */
  reply(input: ReplyInput): Promise<ReplyResult>;
  /** Stops the run. What it produced so far is kept, and the run ends as aborted. */
  abort(): Promise<void>;
  /**
   * Summarizes the session's older messages into what the model reads from then on. The thread keeps them. Resolves
   * once the compaction is admitted. It runs while the session keeps working, and its summary lands at once when the
   * session is idle, else at the run's next boundary. The stream shows `compaction:start`, then `session:compacted`
   * and `compaction:end`, or `compaction:end` with an `error`.
   */
  compact(options?: CompactOptions): Promise<void>;
  /**
   * Changes which tools the session may use and which of its calls wait for approval, in one commit. A tool change
   * applies from the run's next model request. An approval change applies to calls that reach the gate after it, and
   * a call already waiting keeps waiting for its decision.
   */
  configure(change: SessionChange): Promise<void>;
  settings(): Promise<SessionSettings>;
  /**
   * Deletes the session and its child sessions. It stops its run, ends their readers and hides them at once, so their
   * calls reject with `SessionNotFoundError`. The host erases their data once the instance's storage is closed by an
   * idle close, by `close()`, or by the next close after a crash. A host without `erase` keeps it.
   */
  delete(): Promise<void>;
}

/** One named instance, which is one open Harness over its scope's storage. */
export interface AgentInstance {
  readonly scope: StorageScope;
  readonly agent: AgentDefinition;
  readonly state: InstanceState;
  /**
   * Opens the instance now rather than at first use. Rejects with `LeaseHeldError`. With `closeIdleAfterMs` it may
   * close again once idle, and the next call reopens it.
   */
  open(): Promise<void>;
  /** Idempotent with `requestId`. A retry, also after a restart or from another process, returns the first session. */
  createSession(options?: SessionOptions): Promise<SessionInfo>;
  /** Oldest first, in one read of the instance's sessions record. A child session is left out. Its parent names it. */
  listSessions(): Promise<SessionInfo[]>;
  session(id: string): AgentSession;
  /** For an `alarm` host whose alarm fired. Runs what is due and what a lost process left. */
  resume(): Promise<void>;
  /**
   * With `modelsFor`, resolves the instance's models again now, so the next model request of a run already going uses
   * them. It does nothing while the instance is not open, since its next open resolves them anyway. It also does
   * nothing with a static `models`.
   */
  refreshModels(): Promise<void>;
  /**
   * With `extensionsFor`, resolves the instance's app extensions again and puts them in place, so the next model
   * request offers their tools, also in a run already going. An extension with the name of an installed one replaces
   * it. One no longer listed is no longer selected but stays installed until the instance closes, so a task it started
   * still runs. It rejects and changes nothing where an open would fail, with a `TypeError` for their names. Refreshes
   * take effect one at a time, in call order. While the instance opens, it waits for the open. While the instance is
   * not open, it does nothing, since its next open resolves them anyway.
   */
  refreshExtensions(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRuntimeInspection {
  /** Instances that hold, or are acquiring or releasing, their scope's lease. */
  readonly open: number;
  /** Every instance the runtime holds: the open ones, and those closed for idleness that it reopens for a due sleep. */
  readonly instances: readonly InstanceInspection[];
}

export interface RecoverOptions {
  /** How many instances open at a time. It defaults to 4. */
  readonly concurrency?: number;
}

/** What `recover()` did with each scope the host listed. */
export interface RecoverResult {
  /** Opened, so they carry on what they left: a run, a call, a due sleep. */
  readonly opened: readonly StorageScope[];
  /** Another writer holds them and carries on their work. A crashed writer's lease frees them once it expires. */
  readonly held: readonly StorageScope[];
  /** Of an agent kind this runtime does not have. */
  readonly unknown: readonly StorageScope[];
  readonly failed: readonly { readonly scope: StorageScope; readonly error: unknown }[];
}

export interface AgentRuntime {
  /**
   * The instance `name` of `agent`, opened lazily. A runtime has one per scope. While the app holds a handle, `get`
   * returns that same handle, also after an idle close.
   */
  get(agent: AgentDefinition | string, name: string): AgentInstance;
  /**
   * Opens every instance the host's `unfinished()` lists, so the run, call or sleep that a crashed or closed process
   * left carries on without waiting for a call. With `closeIdleAfterMs`, those with nothing to do close again once
   * idle. Run it at startup, and again from time to time where several processes share a storage, to take over the
   * scopes of one that crashed once their leases expire. Throws a `TypeError` for a host without `unfinished`.
   */
  recover(options?: RecoverOptions): Promise<RecoverResult>;
  /** What the runtime holds now. */
  inspect(): AgentRuntimeInspection;
  close(): Promise<void>;
}

const SESSION_ID = /^[1-9]\d{0,15}$/;
const SUBMISSION_ID = SESSION_ID;

/** setTimeout's longest delay. A later deadline is reached in steps. */
const MAX_DELAY = 2 ** 31 - 1;

interface Opened {
  readonly harness: Harness;
  readonly storage: Storage;
  readonly lease: Lease;
  readonly models: ModelAccess | undefined;
  readonly detach: AbortController;
  readonly tools: ReadonlyMap<string, ToolRegistration>;
  readonly registry: Registry;
  readonly app: { current: AppExtensions };
  refreshing: Promise<void>;
  readonly courier: Courier;
  sessions: SessionsState | undefined;
  failed: boolean;
}

interface RuntimeCore {
  readonly options: AgentRuntimeOptions<unknown>;
  readonly clock: Clock;
  courier: CourierTiming;
  hold(instance: Instance): void;
  letGo(instance: Instance): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  timer(callback, ms, keepAlive) {
    const handle = setTimeout(callback, Math.min(Math.max(ms, 0), MAX_DELAY));
    // SAFETY: Node.js timers have `unref`; other runtimes have nothing to unreference.
    if (!keepAlive) (handle as { unref?: () => void }).unref?.();
    return () => clearTimeout(handle);
  },
};

const ignore = (_error: unknown): void => undefined;

const toollessAgent = (kind: string): AgentDefinition => defineAgent({ kind, instructions: "", tools: [] });

function refusedMetadata({ metadata, replyTo }: SubmitInput): string | undefined {
  if (metadata === undefined) return undefined;
  if (replyTo !== undefined) return "An ask takes no `metadata`";
  const object = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata);
  return object && isJsonValue(metadata) ? undefined : "`metadata` is not a JSON object";
}

class Instance implements AgentInstance {
  readonly scope: StorageScope;
  readonly agent: AgentDefinition;
  readonly #agents: ReadonlyMap<string, AgentDefinition>;
  readonly #options: AgentRuntimeOptions<unknown>;
  readonly #courierTiming: () => CourierTiming;
  readonly #lifecycle: InstanceLifecycle<Opened>;
  readonly #watches = new Map<ConversationId, SessionWatch>();
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

  get closed(): boolean {
    return this.#lifecycle.ended !== undefined;
  }

  get state(): InstanceState {
    return this.#lifecycle.state;
  }

  inspection(): InstanceInspection {
    return this.#lifecycle.inspection();
  }

  #report(report: InstanceReport) {
    try {
      this.#options.onReport?.(report);
    } catch (appError) {
      ignore(appError);
    }
  }

  #runtimeReport(kind: AgentRuntimeReportKind, error: unknown) {
    this.#report({ source: "runtime", scope: this.scope, kind, error });
  }

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

  #agentOf(opened: Opened, conversationId: ConversationId): AgentDefinition {
    const kind = opened.sessions?.sessions[String(conversationId)]?.agent;
    if (kind === undefined) return this.agent;
    return this.#agents.get(kind) ?? toollessAgent(kind);
  }

  #toolInfo(opened: Opened, conversationId: ConversationId): (name: string) => ToolInfo {
    return (name) => {
      const agent = this.#agentOf(opened, conversationId);
      const tool = opened.app.current.catalog.tool(agent.kind, name);
      return {
        label: tool.label,
        tier: tool.tier ?? UNKNOWN_TIER,
        gated: isGated(agent, tool, ruleOf(opened.sessions, conversationId)),
      };
    };
  }

  async #open(): Promise<Opened> {
    const { host } = this.#options;
    const lease = await host.lease(this.scope);
    const detach = new AbortController();
    let storage: Storage | undefined;
    let harness: Harness | undefined;
    try {
      if (lease.signal.aborted) throw new InstanceClosedError(this.scope, "lease_lost");
      storage = await host.storage(this.scope, lease);
      const options = this.#options;
      let models: ModelAccess | undefined;
      let harnessModels: HarnessOptions["models"];
      if (options.modelsFor === undefined) {
        harnessModels = options.models;
      } else {
        models = new ModelAccess(this.scope, options.modelsFor, (error) => this.#runtimeReport("models_failed", error));
        harnessModels = models.get;
      }
      await models?.refresh();
      const app = { current: await this.#appExtensions() };
      const registry = createRegistry();
      const extensions = agentExtensions(this.#agents, {
        scope: this.scope,
        ports: this.#portsOf,
        portsFailed: this.#portsFailed,
        app: () => app.current,
        nestedApprovalTimeoutMs: nestedApprovalTimeoutOf(this.#options),
      });
      for (const extension of extensions.values()) registry.install(extension);
      for (const extension of app.current.installed) registry.install(extension);
      const { courier, extension: asks } = askCourier({
        deliver: this.#options.deliverReply,
        timing: this.#courierTiming,
        failed: (failure) => this.#report({ source: "runtime", scope: this.scope, kind: "reply_failed", ...failure }),
      });
      registry.install(asks);
      const own = extensions.get(this.agent.kind)!;
      const tools = new Map((own.tools ?? []).map((tool) => [tool.name, tool]));
      const appSettings = this.#options.settings;
      const telemetry = this.#options.telemetryFor?.(this.scope);
      const env = this.#options.envFor?.(this.scope);
      const { wake } = host;
      harness = await Harness.open(
        storage,
        {
          ...(telemetry !== undefined && { telemetry }),
          ...(env !== undefined && { env }),
          models: harnessModels,
          registry,
          settings: () => ({
            ...(typeof appSettings === "function" ? appSettings() : appSettings),
            extensions: app.current.selectionOf(this.agent.kind, own),
          }),
          onReport: (report) => this.#report({ source: "pi", scope: this.scope, report }),
          ...(wake.kind === "alarm" && {
            onWake: (state) => {
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
        registry,
        app,
        refreshing: Promise.resolve(),
        courier,
        sessions: undefined,
        failed: false,
      };
      const ended = this.#lifecycle.ended;
      if (ended !== undefined) throw new InstanceClosedError(this.scope, ended);
      lease.signal.addEventListener("abort", () => void this.#lifecycle.end("lease_lost"), {
        once: true,
        signal: detach.signal,
      });
      void harness.closed.then((end) => {
        if (end.kind !== "failed") return;
        opened.failed = true;
        if (!detach.signal.aborted) void this.#lifecycle.end("failed");
      });
      const blocked = new Set<TaskId>();
      const reportBlocked = (graph: TaskGraph) => {
        for (const task of Object.values(graph.tasks)) {
          if (task.blocked === undefined || blocked.has(task.id)) continue;
          blocked.add(task.id);
          const report: InstanceReport = {
            source: "runtime",
            scope: this.scope,
            kind: "task_blocked",
            sessionId: String(task.conversationId),
            taskKind: task.kind,
            reason: task.blocked,
          };
          // An observer of the task graph only records, so the app's handler runs once the graph's change is adopted.
          queueMicrotask(() => this.#report(report));
        }
      };
      const graph = await harness.observeTaskGraph(
        {
          advance: (call) => {
            this.#lifecycle.touch();
            if (call.kind === "value") reportBlocked(call.value);
          },
          end: () => undefined,
        },
        context,
      );
      reportBlocked(graph.value);
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
        harness.resume();
      } finally {
        for (const release of holds) release();
      }
      return opened;
    } catch (error) {
      detach.abort();
      this.#closeWatches();
      if (harness) await harness.close(context).catch(() => undefined);
      else await storage?.close(context).catch(() => undefined);
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  async #release(opened: Opened): Promise<void> {
    const { harness, lease, detach } = opened;
    detach.abort();
    this.#closeWatches();
    const erase = this.#options.host.erase;
    const usable = !opened.failed && !lease.signal.aborted;
    const doomed = erase === undefined || !usable ? [] : await this.#toErase(harness);
    let wake: Wake | undefined;
    try {
      wake = harness.wake();
    } catch {
      // A failed Harness throws `SessionFailed`. Released without a wake, the scope counts as unfinished.
    }
    await harness.close(context).catch((error: unknown) => this.#runtimeReport("close_failed", error));
    if (doomed.length > 0 && erase !== undefined && !lease.signal.aborted) {
      await erase
        .call(this.#options.host, this.scope, lease, doomed)
        .catch((error: unknown) => this.#runtimeReport("erase_failed", error));
    }
    await lease.release(wake).catch((error: unknown) => this.#runtimeReport("lease_release_failed", error));
  }

  async #toErase(harness: Harness): Promise<ConversationId[]> {
    try {
      const erasing = (await harness.snapshot(SessionsDoc, context))?.erasing ?? [];
      if (erasing.length === 0) return [];
      const left: ConversationId[] = [];
      for (const id of erasing) {
        const conversation = await harness.conversation(idFromNumber<ConversationId>(id), context);
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
   * Runs a call that can start work with an alarm host armed for it. The alarm is `active` from before the call until
   * it is done, so a process that dies while the call starts work is woken. Then it is armed with what is due, since
   * pi-durable reports only a change to its wake, and a call that started nothing changes none. Of calls that overlap,
   * the last one done arms what is due. A failure to arm after the call is reported, and the call stands.
   */
  async #armedFor<R>(harness: Harness, call: () => Promise<R>): Promise<R> {
    const { wake } = this.#options.host;
    if (wake.kind !== "alarm") return call();
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
        // A failed Harness throws `SessionFailed`. Its scope stays armed active, so it is woken to recover.
      }
      if (due !== undefined) {
        await this.#arm(wake, due).catch((error: unknown) => this.#runtimeReport("arm_failed", error));
      }
    }
  }

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
    watch.ready.catch(() => undefined);
    return watch;
  }

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

  heldStreams(): { readonly sessions: number; readonly events: number; readonly readers: number } {
    let events = 0;
    let readers = 0;
    for (const watch of this.#watches.values()) {
      events += watch.held.events;
      readers += watch.held.readers;
    }
    return { sessions: this.#watches.size, events, readers };
  }

  async #readSessions(opened: Opened): Promise<SessionsState | undefined> {
    opened.sessions = await opened.harness.snapshot(SessionsDoc, context);
    return opened.sessions;
  }

  async #conversation(opened: Opened, sessionId: string): Promise<Conversation> {
    const sessions = await this.#readSessions(opened);
    const conversation =
      SESSION_ID.test(sessionId) && sessions?.sessions[sessionId] !== undefined
        ? await opened.harness.conversation(idFromNumber<ConversationId>(Number(sessionId)), context)
        : undefined;
    if (!conversation) throw new SessionNotFoundError(sessionId);
    return conversation;
  }

  #refuseOwned(opened: Opened, sessionId: string) {
    if (opened.sessions?.sessions[sessionId]?.parent !== undefined) throw new SessionOwnedError(sessionId);
  }

  #toolsChange(opened: Opened, names: readonly string[] | null): Pick<AgentChange, "tools"> {
    if (names === null) return { tools: null };
    const enabled = new Set(names);
    return { tools: { remove: [...opened.tools.values()].filter((tool) => !enabled.has(tool.name)) } };
  }

  #storedRule(opened: Opened, rule: ApprovalRule) {
    return storedRule(this.agent.kind, opened.app.current.catalog.tiers(this.agent.kind), rule);
  }

  open(): Promise<void> {
    return this.#lifecycle.run(async () => undefined);
  }

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
    try {
      model = this.#modelOf(options?.model);
      if (options?.tools !== undefined) tools = selectedTools(this.agent, options.tools);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = options?.requestId;
    return this.#lifecycle.run(async (opened) => {
      const requiresApproval = options?.requiresApproval;
      const rule = requiresApproval === undefined ? undefined : this.#storedRule(opened, requiresApproval);
      const session = await opened.harness.commit(async (tx): Promise<SessionInfo> => {
        const doc = await tx.doc(SessionsDoc);
        if (requestId !== undefined) {
          for (const [id, record] of Object.entries(doc.sessions)) {
            if (record.requestId === requestId) return { id, createdAt: record.createdAt };
          }
        }
        const createdAt = Date.now();
        const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
        // pi-durable refuses a `maxTurns` that is not an integer of 1 or more with a `RangeError` and fails the commit.
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

  async refreshExtensions(): Promise<void> {
    const { state } = this;
    if (state !== "open" && state !== "opening") return;
    await this.#lifecycle.run(async (opened) => {
      const refresh = opened.refreshing.then(() => this.#refreshExtensions(opened));
      opened.refreshing = refresh.catch(() => undefined);
      await refresh;
    });
  }

  async #appExtensions(): Promise<AppExtensions> {
    return appExtensions(this.scope, this.#agents, (await this.#options.extensionsFor?.(this.scope)) ?? []);
  }

  async #refreshExtensions(opened: Opened): Promise<void> {
    const app = await this.#appExtensions();
    const { registry } = opened;
    const trial = createRegistry();
    for (const extension of [...registry.snapshot().installed(), ...app.installed]) trial.install(extension);
    opened.app.current = app;
    for (const extension of app.installed) registry.install(extension);
  }

  async close(): Promise<void> {
    await this.#lifecycle.end("closed");
  }

  submit(sessionId: string, input: SubmitInput): Promise<SubmitResult> {
    const { replyTo } = input;
    const refused = refusedMetadata(input) ?? (replyTo === undefined ? undefined : this.#refusedAsk(input));
    if (refused !== undefined) return Promise.reject(new InvalidRequestError(refused));
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      this.#refuseOwned(opened, sessionId);
      return this.#withWatch(opened, conversation, async () => {
        await opened.models?.refresh();
        return this.#armedFor(harness, async () => {
          if (replyTo !== undefined) {
            const { text, requestId } = input;
            return {
              submissionId: String(await ask(harness, conversation, opened.courier, { text, requestId, replyTo })),
            };
          }
          try {
            const entry = inputEntry(input.whenBusy === "steer", input.metadata);
            // pi's `followUp`, its default, is what `queue` asks for. A steer to an idle session starts a run.
            const submission = await conversation.submit(
              {
                type: "input",
                content: input.text,
                requestId: input.requestId,
                ...(input.whenBusy === "steer" && { whenBusy: "steer" as const }),
                ...(input.whenBusy === "reject" && { whenBusy: "reject" as const }),
                ...(entry !== undefined && { entry }),
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

  continue(sessionId: string, input: ContinueInput): Promise<SubmitResult> {
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      this.#refuseOwned(opened, sessionId);
      return this.#withWatch(opened, conversation, async () => {
        await opened.models?.refresh();
        return this.#armedFor(harness, async () => {
          try {
            const { requestId } = input;
            const id = await harness.commit(async (tx) => {
              // pi-durable throws `ReadAfterWrite` for a table read after the admission's writes.
              const known = await tx.submissionByRequest(conversation.id, requestId);
              const admitted = await conversation.submit(tx, { type: "continue", requestId });
              const alone = (await tx.doc(LiveDoc, conversation.id)).run?.inputs.length === 1;
              if (known === undefined && alone) {
                await tx.appendEntry(ContinueEntry, conversation.id, { data: { submissionId: admitted } });
              }
              return admitted;
            }, context);
            return { submissionId: String(id) };
          } catch (error) {
            throw error instanceof ConversationBusy ? new SessionBusyError(sessionId) : error;
          }
        });
      });
    });
  }

  #refusedAsk(input: SubmitInput): string | undefined {
    if (this.#options.deliverReply === undefined)
      return "This runtime cannot reply to an ask: it has no `deliverReply`";
    if (input.whenBusy === "reject") return 'An ask always queues: `replyTo` takes no `whenBusy: "reject"`';
    if (input.whenBusy === "steer") return 'An ask always queues: `replyTo` takes no `whenBusy: "steer"`';
    if (!replyAddressSchema.safeParse(input.replyTo).success) return "`replyTo` is not a reply address";
    return undefined;
  }

  events(sessionId: string, options: EventsOptions | undefined): AsyncGenerator<StreamItem, void, undefined> {
    return this.#lifecycle.read((opened) => this.#stream(opened, sessionId, options));
  }

  async *#stream(opened: Opened, sessionId: string, options: EventsOptions | undefined) {
    const conversation = await this.#conversation(opened, sessionId);
    yield* this.#watchOf(opened, conversation).read(options?.from, options?.signal);
  }

  approve(sessionId: string, decisions: readonly ApprovalDecision[]): Promise<ApprovalOutcome[]> {
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const conversation = await this.#conversation(opened, sessionId);
      return this.#withWatch(opened, conversation, async () => {
        await opened.models?.refresh();
        const rule = ruleOf(opened.sessions, conversation.id);
        const agent = this.#agentOf(opened, conversation.id);
        const gated = (name: string) => isGated(agent, opened.app.current.catalog.tool(agent.kind, name), rule);
        return this.#armedFor(harness, () => decide(harness, conversation.id, gated, decisions));
      });
    });
  }

  reply(sessionId: string, input: ReplyInput): Promise<ReplyResult> {
    return this.#lifecycle.run(async (opened) => {
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
      this.#refuseOwned(opened, sessionId);
      await this.#withWatch(opened, conversation, async () => {
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
      const id = SUBMISSION_ID.test(submissionId) ? idFromNumber<SubmissionId>(Number(submissionId)) : undefined;
      const record = id === undefined ? undefined : await (await harness.submission(id, context))?.status(context);
      if (id === undefined || record?.type !== "input" || record.conversationId !== conversation.id) {
        throw new InvalidRequestError(`Session ${sessionId} has no input ${submissionId}`);
      }
      if (record.notify !== undefined) {
        throw new InvalidRequestError(`Input ${submissionId} is an ask: its asker waits for its answer`);
      }
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
    try {
      if (change.model !== undefined) model = this.#modelOf(change.model ?? undefined);
      if (change.tools !== undefined) tools = change.tools === null ? null : selectedTools(this.agent, change.tools);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#lifecycle.run(async (opened) => {
      const { harness } = opened;
      const requiresApproval = change.requiresApproval;
      const rule =
        requiresApproval === undefined || requiresApproval === null
          ? requiresApproval
          : this.#storedRule(opened, requiresApproval);
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
      // One commit, so pi-durable's `RangeError` for a bad `maxTurns` discards the whole change.
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
      await this.#armedFor(harness, () => conversation.abort(context, { background: true }));
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
      for (const id of deleted) this.#watches.get(idFromNumber<ConversationId>(id))?.close();
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

  continue(input: ContinueInput): Promise<SubmitResult> {
    return this.#instance.continue(this.id, input);
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

const HOUR = 60 * 60 * 1000;

const nestedApprovalTimeoutOf = (options: AgentRuntimeOptions<unknown>) => options.nestedApprovalTimeoutMs ?? HOUR;

function assertOneDefinitionPerKind(roots: readonly AgentDefinition[]): void {
  agentsOf(roots);
}

/**
 * The runtime, which binds agent definitions to a host, model access and the app's ports. Each named instance of an
 * agent is one pi-durable Harness over the storage the host opens for its scope. The instance opens at first use and
 * is held under the host's single-writer lease until it closes. It closes on `close()`, a lost lease, a failed
 * storage, or once idle with `closeIdleAfterMs`, and its next call opens it again.
 */
export function createAgentRuntime<Ports>(options: AgentRuntimeOptions<Ports>): AgentRuntime {
  const agents = new Map<string, AgentDefinition>();
  for (const agent of options.agents) {
    if (agents.has(agent.kind)) throw new TypeError(`Two agents of kind \`${agent.kind}\``);
    agents.set(agent.kind, agent);
  }
  assertOneDefinitionPerKind(options.agents);
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
  const nested = nestedApprovalTimeoutOf(options);
  if (!(Number.isFinite(nested) && nested > 0)) {
    throw new TypeError("`nestedApprovalTimeoutMs` must be a positive number of milliseconds");
  }
  let closed = false;
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

export function setCourierTimingForTests(runtime: AgentRuntime, timing: Partial<CourierTiming>): void {
  const core = cores.get(runtime);
  if (core === undefined) throw new TypeError("Not a runtime made by createAgentRuntime");
  core.courier = { ...core.courier, ...timing };
}

export function heldStreams(instance: AgentInstance): ReturnType<Instance["heldStreams"]> {
  if (!(instance instanceof Instance)) throw new TypeError("Not an instance made by createAgentRuntime");
  return instance.heldStreams();
}
