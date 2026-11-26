import type { Wake } from "@earendil-works/pi-durable";
import type { LifecycleJobOutcome } from "agents/lifecycle";

import type { AgentInstance, AgentRuntime } from "@chia1104/motoko-core";

export interface WakeTiming {
  /** The longest one wake waits inside an alarm, which may run 15 minutes. Longer work is waited on across alarms. */
  readonly waitBudgetMs: number;
  readonly heartbeatMs: number;
}

/** What the wake loop resumes, and how it keeps the wake job. */
export interface WakeTarget {
  /** The runtime open now. A wait lasts while the runtime it began in is still this one. */
  runtime(): AgentRuntime | undefined;
  instance(): AgentInstance;
  /** Keeps the wake job at what `wake` says is due. */
  schedule(wake: Wake): Promise<void>;
  /** Counts `work` against the alarm's memory-limit breaker. False outside an alarm. */
  trackAlarmWork(work: Promise<void>): boolean;
}

interface Waiting {
  readonly kind: "waiting";
  endSleep: (() => void) | undefined;
}

type Phase = { readonly kind: "idle" } | { readonly kind: "stepping" } | Waiting;

const IDLE: Phase = { kind: "idle" };
const STEPPING: Phase = { kind: "stepping" };

/**
 * The wake job's loop over the newest wake the runtime armed. While a step or its wait on running work is under way,
 * an arm only records the newest wake, so the job is never moved under itself.
 */
export class WakeLoop {
  timing: WakeTiming = { waitBudgetMs: 10 * 60_000, heartbeatMs: 30_000 };
  readonly #target: WakeTarget;
  #wake: Wake | undefined;
  #phase: Phase = IDLE;

  constructor(target: WakeTarget) {
    this.#target = target;
  }

  async arm(wake: Wake): Promise<void> {
    this.#wake = wake;
    this.#endSleep();
    if (this.#phase.kind === "idle") await this.#target.schedule(wake);
  }

  /** Ends the wait's sleep, so a wait whose runtime closed ends too. */
  runtimeClosed(): void {
    this.#endSleep();
  }

  async step(): Promise<LifecycleJobOutcome> {
    const heartbeat = { rescheduleAt: Date.now() + this.timing.heartbeatMs };
    if (this.#phase.kind === "waiting") return heartbeat;
    this.#phase = STEPPING;
    let instance: AgentInstance;
    try {
      instance = this.#target.instance();
      await instance.resume();
    } finally {
      this.#phase = IDLE;
    }
    const wake = this.#wake;
    if (wake?.active === true) {
      this.#waitPastTheStep(instance);
      return heartbeat;
    }
    return wake?.at === undefined ? undefined : { rescheduleAt: wake.at };
  }

  #waitPastTheStep(instance: AgentInstance): void {
    const runtime = this.#target.runtime();
    const sameRuntime = () => this.#target.runtime() === runtime;
    const waiting: Waiting = { kind: "waiting", endSleep: undefined };
    this.#phase = waiting;
    const work = (async () => {
      try {
        await this.#waitWhileActive(instance, waiting, sameRuntime);
      } finally {
        this.#phase = IDLE;
      }
      if (sameRuntime()) await this.#target.schedule(this.#wake ?? { active: false });
    })();
    // Inside an alarm, this wait counts against the alarm's memory-limit breaker. Outside an alarm, the heartbeat
    // alone covers it.
    if (!this.#target.trackAlarmWork(work)) work.catch(() => undefined);
  }

  async #waitWhileActive(instance: AgentInstance, waiting: Waiting, sameRuntime: () => boolean): Promise<void> {
    const deadline = Date.now() + this.timing.waitBudgetMs;
    for (let wake = this.#wake; wake?.active === true && sameRuntime(); wake = this.#wake) {
      const now = Date.now();
      if (now >= deadline) return;
      const until = Math.min(deadline, wake.at ?? deadline);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(until - now, 0));
        waiting.endSleep = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      waiting.endSleep = undefined;
      const at = this.#wake?.at;
      // With an alarm host, pi-durable arms no timer for a sleep of its own.
      if (sameRuntime() && at !== undefined && Date.now() >= at) await instance.resume();
    }
  }

  #endSleep(): void {
    if (this.#phase.kind === "waiting") this.#phase.endSleep?.();
  }
}
