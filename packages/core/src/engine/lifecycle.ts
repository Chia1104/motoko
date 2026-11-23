import type { Wake } from "@earendil-works/pi-durable";

import { InstanceClosedError, LeaseHeldError } from "../errors.ts";
import type { StorageScope } from "../host.ts";

/**
 * Where an instance is. `dormant`: holds nothing (not opened yet, or closed for idleness) and opens
 * at its next call. `opening`, `open`, `closing` (an idle close releasing its lease): it holds or
 * is acquiring its scope's lease. `closed`, `lease_lost`, `failed`: it ended and never reopens.
 */
export type InstanceState = "dormant" | "opening" | "open" | "closing" | "closed" | "lease_lost" | "failed";

/** How an instance ended; it never reopens. */
export type Ended = "closed" | "lease_lost" | "failed";

/** What the runtime holds for one instance, for tests and operators. */
export interface InstanceInspection {
  readonly scope: StorageScope;
  readonly state: InstanceState;
  /** Calls of the runtime's under way on it. */
  readonly operations: number;
  /** Event readers attached to its sessions. */
  readonly readers: number;
  /** Closed for idleness with a sleep due then: the runtime reopens it at that time (epoch ms). */
  readonly wakeAt?: number;
}

/** Time as a lifecycle reads it and waits on it: the system's in a runtime, a test's own in its tests. */
export interface Clock {
  now(): number;
  /**
   * Calls `callback` once `ms` have passed, unless the function it returns cancels it first. It may
   * call back early, so a deadline is checked against `now()`. A timer without `keepAlive` only
   * frees resources, so it does not keep a Node.js process alive.
   */
  timer(callback: () => void, ms: number, keepAlive: boolean): () => void;
}

/** What a lifecycle needs of its instance, and of the runtime that holds the instance. */
export interface LifecycleOptions<T> {
  readonly scope: StorageScope;
  readonly clock: Clock;
  /** `closeIdleAfterMs`; undefined keeps the instance open until it ends. */
  readonly idleMs: number | undefined;
  /**
   * Acquires the scope's lease and opens the instance under it; what it resolves with is what calls
   * run against. It checks `ended` before it writes. A rejection fails the calls waiting for it,
   * and the next call opens again.
   */
  open(): Promise<T>;
  /** Releases what one open holds, its lease last. It reports its own failures and never rejects. */
  release(opened: T): Promise<void>;
  /** pi-durable's wake of one open: whether a task can run now or is running, and its next sleep. */
  wake(opened: T): Wake;
  /**
   * With an alarm host: arms it with what is due, before an idle close, since its alarm is what
   * wakes the scope once closed. Without one, the lifecycle itself reopens an instance closed with
   * a sleep due, at its time.
   */
  readonly arm: ((wake: Wake) => Promise<void>) | undefined;
  report(kind: "arm_failed" | "reopen_failed", error: unknown): void;
  /** The instance holds a lease, acquires or releases one, or waits to reopen for a sleep: the runtime keeps it. */
  hold(): void;
  /** It holds nothing any more. */
  letGo(): void;
}

/** A sleep the instance was closed with: the reopen for it. */
interface Sleep {
  /** Epoch ms. */
  readonly at: number;
  cancel: () => void;
}

interface Open<T> {
  readonly kind: "open";
  readonly opened: T;
  /** When the instance was last seen doing something. */
  lastActivity: number;
  /** Cancels the idle check that waits, if one does. */
  cancelIdle: (() => void) | undefined;
}

/** Where the instance is, with exactly what it holds there. */
type Phase<T> =
  | { readonly kind: "dormant"; readonly sleep?: Sleep }
  | { readonly kind: "opening"; readonly opening: Promise<T> }
  | Open<T>
  /** An idle close releasing the lease; a call that comes meanwhile waits for it, then reopens. */
  | { readonly kind: "closing"; readonly closing: Promise<void> }
  | { readonly kind: "ended"; readonly reason: Ended };

/**
 * One instance's lifecycle. It opens at its first call; with `idleMs` it closes once idle, and
 * opens again at its next call or, without an alarm host, when a sleep it was closed with comes
 * due; it ends for good when it is closed, loses its lease or its storage fails. Calls and event
 * readers run against the open instance, and each keeps it open while it lasts.
 */
export class InstanceLifecycle<T> {
  readonly #options: LifecycleOptions<T>;
  #phase: Phase<T> = { kind: "dormant" };
  /** Calls under way, and attached readers: each keeps the instance open. */
  #operations = 0;
  #readers = 0;

  constructor(options: LifecycleOptions<T>) {
    this.#options = options;
  }

  get state(): InstanceState {
    return this.#phase.kind === "ended" ? this.#phase.reason : this.#phase.kind;
  }

  /** How the instance ended, once it has. */
  get ended(): Ended | undefined {
    return this.#phase.kind === "ended" ? this.#phase.reason : undefined;
  }

  /** What the open made, while the instance is open. */
  get opened(): T | undefined {
    return this.#phase.kind === "open" ? this.#phase.opened : undefined;
  }

  inspection(): InstanceInspection {
    const phase = this.#phase;
    return {
      scope: this.#options.scope,
      state: this.state,
      operations: this.#operations,
      readers: this.#readers,
      ...(phase.kind === "dormant" && phase.sleep !== undefined && { wakeAt: phase.sleep.at }),
    };
  }

  /** Runs one call against the open instance, opening it first if need be; while it runs, the instance is not idle. */
  async run<R>(call: (opened: T) => Promise<R>): Promise<R> {
    this.#operations += 1;
    try {
      return await call(await this.#ready());
    } finally {
      this.#operations -= 1;
      this.touch();
    }
  }

  /** Reads `stream` from the open instance; the reader keeps it open from its first step until it ends. */
  async *read<R>(stream: (opened: T) => AsyncIterable<R>): AsyncGenerator<R, void, undefined> {
    this.#readers += 1;
    try {
      yield* stream(await this.#ready());
    } finally {
      this.#readers -= 1;
      this.touch();
    }
  }

  /** Something happened: idleness counts from now. Starts the idle check if none waits. */
  touch(): void {
    const phase = this.#phase;
    const { clock, idleMs } = this.#options;
    if (phase.kind !== "open") return;
    phase.lastActivity = clock.now();
    if (idleMs === undefined || phase.cancelIdle !== undefined) return;
    phase.cancelIdle = clock.timer(() => void this.#checkIdle(phase, idleMs), idleMs, false);
  }

  /** Ends the instance: closed, its lease lost, or its storage failed. It never reopens. */
  async end(reason: Ended): Promise<void> {
    const phase = this.#phase;
    if (phase.kind === "ended") return;
    this.#phase = { kind: "ended", reason };
    let opened: T | undefined;
    switch (phase.kind) {
      case "dormant":
        phase.sleep?.cancel();
        break;
      case "open":
        phase.cancelIdle?.();
        opened = phase.opened;
        break;
      case "opening":
        // An open under way sees the end and fails, releasing what it took; one already past that
        // check resolves, and what it made is released here.
        opened = await phase.opening.catch(() => undefined);
        break;
      case "closing":
        await phase.closing;
        break;
    }
    // A lost lease means another writer may take over: stop writing at once.
    if (opened !== undefined) await this.#options.release(opened);
    this.#options.letGo();
  }

  /**
   * The open instance, opening it on first use and again after an idle close; a call that comes
   * while an idle close releases the lease waits for it, then opens anew, so the lease is never
   * asked for twice and no two writers overlap. A failed open is tried again by the next call. An
   * open that the instance ended during is never handed out, even one past its check for an end:
   * its callers fail as the instance ended, while `end` releases what it made. Only `run` and
   * `read` call this, having counted their caller, so no idle close starts while the caller uses
   * what this returns.
   */
  async #ready(): Promise<T> {
    for (;;) {
      const phase = this.#phase;
      switch (phase.kind) {
        case "ended":
          throw new InstanceClosedError(this.#options.scope, phase.reason);
        case "closing":
          await phase.closing;
          continue;
        case "opening":
          await phase.opening;
          continue;
        case "open":
          return phase.opened;
        case "dormant":
          await this.#startOpening(phase.sleep);
          continue;
      }
    }
  }

  #startOpening(sleep: Sleep | undefined): Promise<T> {
    sleep?.cancel();
    this.#options.hold();
    const opening = this.#options.open();
    const phase: Phase<T> = { kind: "opening", opening };
    this.#phase = phase;
    opening.then(
      (opened) => {
        if (this.#phase !== phase) return;
        this.#phase = { kind: "open", opened, lastActivity: this.#options.clock.now(), cancelIdle: undefined };
        this.touch();
      },
      () => {
        if (this.#phase !== phase) return;
        this.#phase = { kind: "dormant" };
        this.#options.letGo();
      },
    );
    return opening;
  }

  /** No call is under way and no reader is attached. */
  #unused(): boolean {
    return this.#operations === 0 && this.#readers === 0;
  }

  /**
   * Whether pi-durable has nothing for this process to do soon: no task that can run now or is
   * running, and no sleep due within the idle time. A call parked on a signal (an approval) counts
   * for nothing: it needs a process only once its decision arrives, and `approve()` reopens.
   */
  #restful(opened: T, idleMs: number): boolean {
    const { active, at } = this.#options.wake(opened);
    return !active && (at === undefined || at - this.#options.clock.now() > idleMs);
  }

  async #checkIdle(open: Open<T>, idleMs: number): Promise<void> {
    open.cancelIdle = undefined;
    // A call or reader under way touches the instance when it ends, which starts the next check.
    if (this.#phase !== open || !this.#unused()) return;
    const { clock, arm } = this.#options;
    const left = open.lastActivity + idleMs - clock.now();
    if (left > 0) {
      open.cancelIdle = clock.timer(() => void this.#checkIdle(open, idleMs), left, false);
      return;
    }
    if (!this.#restful(open.opened, idleMs)) {
      this.touch();
      return;
    }
    if (arm !== undefined) {
      // The host's alarm is what wakes the scope once closed: it must say what is due before the close.
      try {
        await arm(this.#options.wake(open.opened));
      } catch (error) {
        this.#options.report("arm_failed", error);
        this.touch();
        return;
      }
      // Whatever happened while the host armed counts: the close needs a whole quiet period still.
      if (this.#phase !== open || open.cancelIdle !== undefined || !this.#unused()) return;
      if (open.lastActivity + idleMs > clock.now() || !this.#restful(open.opened, idleMs)) {
        this.touch();
        return;
      }
    }
    this.#closeIdle(open.opened);
  }

  /**
   * Closes the instance for idleness: `release` lets go of what the open holds, its lease last.
   * Calls that come meanwhile wait in `#ready()` and reopen once the lease is free. Without an
   * alarm host, a sleep due later reopens the instance at its time.
   */
  #closeIdle(opened: T) {
    const { at } = this.#options.wake(opened);
    // Closing before the release starts, so nothing it sets off finds the instance open.
    const closing = Promise.resolve()
      .then(() => this.#options.release(opened))
      .finally(() => {
        // An end that came meanwhile stands.
        if (this.#phase.kind !== "closing") return;
        if (at !== undefined && this.#options.arm === undefined) {
          this.#sleepUntil(at);
        } else {
          this.#phase = { kind: "dormant" };
          this.#options.letGo();
        }
      });
    this.#phase = { kind: "closing", closing };
  }

  /**
   * Waits, dormant, to reopen the instance when a sleep it was closed with is due, so pi-durable
   * runs it; the runtime keeps the instance meanwhile. A reopen that fails is reported and tried
   * again, unless another writer holds the scope: that writer runs the sleep.
   */
  #sleepUntil(at: number) {
    const { clock } = this.#options;
    const fire = () => {
      if (at > clock.now()) {
        sleep.cancel = clock.timer(fire, at - clock.now(), true);
        return;
      }
      this.run(async () => undefined).catch((error: unknown) => {
        this.#options.report("reopen_failed", error);
        // Opened by a call since, or ended: nothing waits for this sleep any more.
        if (this.#phase.kind !== "dormant" || error instanceof LeaseHeldError) return;
        this.#sleepUntil(clock.now() + Math.min(Math.max(this.#options.idleMs ?? 0, 1_000), 60_000));
      });
    };
    const sleep: Sleep = { at, cancel: clock.timer(fire, at - clock.now(), true) };
    this.#phase = { kind: "dormant", sleep };
    this.#options.hold();
  }
}
