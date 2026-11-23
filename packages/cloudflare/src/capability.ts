import type { Wake } from "@earendil-works/pi-durable";
import { LifecycleCapability } from "agents/lifecycle";
import type { LifecycleJobContext, LifecycleJobOutcome, WSMessage } from "agents/lifecycle";

import { createAgentRuntime, scopeKey } from "@chia1104/motoko-core";
import type {
  AgentDefinition,
  AgentHost,
  AgentInstance,
  AgentRuntime,
  AgentRuntimeModelsOption,
  AgentRuntimeOptions,
  AgentRuntimePortsOption,
  AgentStore,
  StorageScope,
} from "@chia1104/motoko-core";

import { MotokoSockets } from "./socket.ts";
import type { MotokoAuthorize, MotokoConnections } from "./socket.ts";
import { durableObjectStore } from "./store.ts";

/**
 * What `MotokoCapability` takes: the one agent the object runs, the runtime options of `createAgentRuntime` for it
 * (model access and ports, `closeIdleAfterMs`, `defaultModel`, `onReport`, `settings`, `deliverReply`), optionally its
 * store, and the connections to serve its socket protocol on.
 */
export type MotokoCapabilityOptions<Ports> = Pick<
  AgentRuntimeOptions<Ports>,
  "closeIdleAfterMs" | "defaultModel" | "onReport" | "settings" | "deliverReply"
> &
  AgentRuntimeModelsOption &
  AgentRuntimePortsOption<Ports> & {
    /** The agent this object runs: its instance is the one named after the object. */
    readonly agent: AgentDefinition<Ports>;
    /** Default: the object's own SQLite database (`durableObjectStore`). */
    readonly store?: AgentStore;
    /**
     * The object's connections (the `Agent` itself, or the `WebSockets` capability of a plain Durable Object), to serve
     * Motoko's socket protocol on beside the app's own frames. Without them the capability claims no frame.
     */
    readonly connections?: MotokoConnections;
    /**
     * Runs before every call on `connections`, after its params parse and after the SDK's readonly mark let it through:
     * `false` answers it `forbidden` and runs nothing. A throw is reported and answered `internal`.
     */
    readonly authorize?: MotokoAuthorize;
  };

/** The capability's id, and with it its jobs' owner: fixed, so a pending job keeps its owner across deploys. */
const CAPABILITY_ID = "motoko";
/** The one job that wakes the object's instance. */
const WAKE_JOB = "motoko-wake";
const WAKE_FN = "wake";

/** How long the wake waits on running work, and how far out it keeps its job meanwhile. Only tests shorten them. */
interface WakeTiming {
  /** The longest one wake waits inside an alarm, which may run 15 minutes; longer work is waited on across alarms. */
  readonly waitBudgetMs: number;
  /** While work runs, the wake job stays due this soon, so an evicted object is restarted to carry it on. */
  readonly heartbeatMs: number;
}

const TIMING: WakeTiming = { waitBudgetMs: 10 * 60_000, heartbeatMs: 30_000 };

/** The longest a wake job whose runs keep failing waits to try again; its delay doubles from the heartbeat. */
const MAX_BACKOFF_MS = 10 * 60_000;
/** Wake runs that failed in a row, in the object's storage, so the backoff holds across evictions. */
const WAKE_ERRORS_KEY = "motoko:wake-errors";

let setTiming: (capability: MotokoCapability, timing: Partial<WakeTiming>) => void;

/** @internal Shortens a capability's wake timings, so a test does not sit on the real heartbeat. Not exported. */
export function setWakeTimingForTests(capability: MotokoCapability, timing: Partial<WakeTiming>): void {
  setTiming(capability, timing);
}

/**
 * Motoko's runtime in a Durable Object, as an Agents SDK capability: one instance, the one whose scope is this object
 * (`{ kind: agent.kind, name }` with the object's name), on a host made of the store and the object's alarm.
 *
 * The runtime arms the host with pi-durable's wake, and the capability keeps one Lifecycle job for it: due now while
 * work can run, due at the earliest sleep, and cancelled when nothing is due. When the job runs it resumes the
 * instance, which opens it if need be and carries on what a lost isolate left; while work runs, it waits on it, at
 * most ten minutes in one alarm, with the job a heartbeat out, so an evicted object is restarted to carry it on.
 */
export class MotokoCapability<Ports = unknown> extends LifecycleCapability {
  readonly #options: MotokoCapabilityOptions<Ports>;
  #host: AgentHost | undefined;
  #runtime: AgentRuntime | undefined;
  /** The newest wake the runtime armed the host with: what pi-durable has to do. */
  #wake: Wake | undefined;
  /** A run of the wake job is under way: it decides from the newest wake when it is done. */
  #stepping = false;
  /** The wait on running work a run of the wake job started, which outlives that run. */
  #waiting: Promise<void> | undefined;
  /** Ends the wait's current sleep early: the wake changed. */
  #changed: (() => void) | undefined;
  #timing = TIMING;
  /** The socket protocol, with `connections`. */
  readonly #sockets: MotokoSockets | undefined;

  static {
    setTiming = (capability, timing) => {
      capability.#timing = { ...capability.#timing, ...timing };
    };
  }

  constructor(options: MotokoCapabilityOptions<Ports>) {
    super(CAPABILITY_ID);
    this.#options = options;
    this.#sockets =
      options.connections &&
      new MotokoSockets(
        options.connections,
        () => this.#instance(),
        (error) =>
          this.lifecycle.events.emit("motoko:socket_error", {
            error: error instanceof Error ? error.message : String(error),
          }),
        options.authorize,
      );
  }

  /** This object's scope: its agent's kind and the object's name. */
  get scope(): StorageScope {
    return { kind: this.#options.agent.kind, name: this.lifecycle.name };
  }

  /** The host the runtime runs on: the store, with the object's alarm as its wake-up. */
  get host(): AgentHost {
    if (this.#host !== undefined) return this.#host;
    const store = this.#options.store ?? durableObjectStore(this.lifecycle.storage, this.scope);
    const erase = store.erase?.bind(store);
    this.#host = {
      lease: (scope) => store.lease(scope),
      storage: (scope, lease) => store.storage(scope, lease),
      ...(erase !== undefined && { erase }),
      wake: { kind: "alarm", arm: (scope, wake) => this.#arm(scope, wake) },
    };
    return this.#host;
  }

  /** This object's instance: its sessions, submissions and decisions. Waits for the object to have started. */
  async instance(): Promise<AgentInstance> {
    await this.lifecycle.ready();
    return this.#instance();
  }

  #instance(): AgentInstance {
    if (this.#runtime === undefined) {
      const { agent, store: _store, ...options } = this.#options;
      this.#runtime = createAgentRuntime({ ...options, agents: [agent], host: this.host });
    }
    return this.#runtime.get(this.#options.agent, this.lifecycle.name);
  }

  /**
   * The object started, after a hibernation or an eviction too: the sessions its open connections followed are read
   * on from their last cursors. Not awaited, so startup does not wait for the instance to open.
   */
  override onStart(): void {
    this.#sockets?.reattach();
  }

  /**
   * Claims the frames of Motoko's socket protocol. The Lifecycle offers a socket's message to every capability before
   * the `WebSockets` catch-all, so Motoko answers its own frames first and the rest reach the app's `onMessage`.
   */
  onWebSocketMessage(ws: WebSocket, message: WSMessage): boolean {
    return this.#sockets?.message(ws, message) ?? false;
  }

  /** Stops the closed connection's readers; the close is left to the `WebSockets` capability, which owns the socket. */
  onWebSocketClose(ws: WebSocket): boolean {
    this.#sockets?.closed(ws);
    return false;
  }

  onWebSocketError(ws: WebSocket): boolean {
    this.#sockets?.closed(ws);
    return false;
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.id !== WAKE_JOB || job.fn !== WAKE_FN) return undefined;
    const outcome = await this.#step();
    // It got through, so a failing wake's backoff starts over.
    const { kv } = this.lifecycle.storage;
    if (kv.get(WAKE_ERRORS_KEY) !== undefined) kv.delete(WAKE_ERRORS_KEY);
    return outcome;
  }

  /**
   * A run of the wake job failed through the Lifecycle's retries, as when the instance cannot open. The Lifecycle
   * would complete the job and nothing would wake the instance's work again, so it tries again later: a heartbeat out,
   * doubling while the failures go on, up to ten minutes.
   */
  onJobError({ job }: LifecycleJobContext, error: unknown): LifecycleJobOutcome {
    if (job.id !== WAKE_JOB || job.fn !== WAKE_FN) return undefined;
    this.lifecycle.events.emit("motoko:wake_error", { error: error instanceof Error ? error.message : String(error) });
    const { kv } = this.lifecycle.storage;
    const errors = (kv.get<number>(WAKE_ERRORS_KEY) ?? 0) + 1;
    kv.put(WAKE_ERRORS_KEY, errors);
    return { rescheduleAt: Date.now() + Math.min(this.#timing.heartbeatMs * 2 ** (errors - 1), MAX_BACKOFF_MS) };
  }

  /**
   * Closes the runtime: its instance's Harness and lease, and the wait on its work. Stored state stays, the wake job
   * too; a later call, or the job, opens a new runtime.
   */
  async dispose(): Promise<void> {
    this.#sockets?.dispose();
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#changed?.();
    await runtime?.close();
  }

  // ─── The wake ──────────────────────────────────────────────────────────────

  /** The host's `arm`: keeps the wake job at what `wake` says is due. */
  async #arm(scope: StorageScope, wake: Wake): Promise<void> {
    const own = scopeKey(this.scope);
    if (scopeKey(scope) !== own) throw new TypeError(`This Durable Object wakes its own scope ${own} alone`);
    this.#wake = wake;
    this.#changed?.();
    // A run of the job, or its wait, reads the newest wake when it is done; meanwhile the job is due.
    if (this.#stepping || this.#waiting !== undefined) return;
    await this.#schedule(wake);
  }

  /** The wake job for `wake`: due now while work can run, at the earliest sleep, and none when nothing is due. */
  async #schedule(wake: Wake): Promise<void> {
    const { jobs } = this.lifecycle;
    const time = wake.active ? Date.now() : wake.at;
    if (time === undefined) {
      await jobs.cancel(WAKE_JOB);
      return;
    }
    await jobs.push({ id: WAKE_JOB, fn: WAKE_FN, time, singleflight: true, recoveryLoop: true });
  }

  /**
   * One run of the wake job. Resuming the instance opens it if need be, which carries on what a lost isolate left,
   * and runs the sleeps now due; it leaves the newest wake in `#wake`. Running work is waited on past this run, inside
   * the alarm's work, with the job a heartbeat out; a sleep reschedules the job for its time; nothing completes it.
   */
  async #step(): Promise<LifecycleJobOutcome> {
    const heartbeat = { rescheduleAt: Date.now() + this.#timing.heartbeatMs };
    if (this.#waiting !== undefined) return heartbeat;
    this.#stepping = true;
    let instance: AgentInstance;
    try {
      instance = this.#instance();
      await instance.resume();
    } finally {
      this.#stepping = false;
    }
    const wake = this.#wake;
    if (wake?.active === true) {
      const runtime = this.#runtime;
      const waiting = this.#waitWhileActive(instance, () => this.#runtime === runtime).then(
        async () => {
          this.#waiting = undefined;
          // Disposed: the job stays as it is, a heartbeat out.
          if (this.#runtime !== runtime) return;
          // Idle now, asleep, or still running at the budget: a fresh alarm waits on for another budget.
          await this.#schedule(this.#wake ?? { active: false });
        },
        (error: unknown) => {
          // The heartbeat that is due already tries again.
          this.#waiting = undefined;
          throw error;
        },
      );
      this.#waiting = waiting;
      // Counted against the alarm's memory-limit breaker; outside an alarm, the heartbeat alone covers it.
      if (!this.lifecycle.trackAlarmWork(waiting)) waiting.catch(() => undefined);
      return heartbeat;
    }
    return wake?.at === undefined ? undefined : { rescheduleAt: wake.at };
  }

  /**
   * Waits while `instance`'s work runs, up to the wait budget, and while `current()`. A changed wake ends each sleep
   * early. A sleep due beside the running work (a retry's backoff) also ends it when due, and the instance is resumed
   * to run it: with an alarm host, pi-durable arms no timer of its own.
   */
  async #waitWhileActive(instance: AgentInstance, current: () => boolean): Promise<void> {
    const deadline = Date.now() + this.#timing.waitBudgetMs;
    for (let wake = this.#wake; wake?.active === true && current(); wake = this.#wake) {
      const now = Date.now();
      if (now >= deadline) return;
      const until = Math.min(deadline, wake.at ?? deadline);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(until - now, 0));
        this.#changed = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#changed = undefined;
      const at = this.#wake?.at;
      if (current() && at !== undefined && Date.now() >= at) await instance.resume();
    }
  }
}
