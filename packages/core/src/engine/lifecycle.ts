import type { Wake } from "@earendil-works/pi-durable";

import { InstanceClosedError, LeaseHeldError } from "../errors.ts";
import type { StorageScope } from "../host.ts";

/**
 * Where an instance is. A `dormant` instance holds nothing, because it has not opened yet or closed for idleness, and
 * it opens at its next call. An `opening`, `open` or `closing` instance holds its scope's lease or is acquiring it. A
 * `closing` instance is an idle close releasing its lease. A `closed`, `lease_lost` or `failed` instance has ended and
 * never reopens.
 */
export type InstanceState = "dormant" | "opening" | "open" | "closing" | "closed" | "lease_lost" | "failed";

export type Ended = "closed" | "lease_lost" | "failed";

/** What the runtime holds for one instance, for tests and operators. */
export interface InstanceInspection {
  readonly scope: StorageScope;
  readonly state: InstanceState;
  /** Calls of the runtime's under way on it. */
  readonly operations: number;
  /** Event readers attached to its sessions. */
  readonly readers: number;
  /** When the instance closed for idleness with a sleep due, the runtime reopens it at this time, in epoch ms. */
  readonly wakeAt?: number;
}

export interface Clock {
  now(): number;
  /** It may call back early, so the caller checks a deadline against `now()`. */
  timer(callback: () => void, ms: number, keepAlive: boolean): () => void;
}

export interface LifecycleOptions<T> {
  readonly scope: StorageScope;
  readonly clock: Clock;
  readonly idleMs: number | undefined;
  open(): Promise<T>;
  release(opened: T): Promise<void>;
  wake(opened: T): Wake;
  readonly arm: ((wake: Wake) => Promise<void>) | undefined;
  report(kind: "arm_failed" | "reopen_failed", error: unknown): void;
  hold(): void;
  letGo(): void;
}

interface Sleep {
  readonly at: number;
  cancel: () => void;
}

interface Open<T> {
  readonly kind: "open";
  readonly opened: T;
  lastActivity: number;
  cancelIdle: (() => void) | undefined;
}

const openedDespiteTheEnd = <T>(opening: Promise<T>): Promise<T | undefined> => opening.catch(() => undefined);

type Phase<T> =
  | { readonly kind: "dormant"; readonly sleep?: Sleep }
  | { readonly kind: "opening"; readonly opening: Promise<T> }
  | Open<T>
  | { readonly kind: "closing"; readonly closing: Promise<void> }
  | { readonly kind: "ended"; readonly reason: Ended };

export class InstanceLifecycle<T> {
  readonly #options: LifecycleOptions<T>;
  #phase: Phase<T> = { kind: "dormant" };
  #operations = 0;
  #readers = 0;

  constructor(options: LifecycleOptions<T>) {
    this.#options = options;
  }

  get state(): InstanceState {
    return this.#phase.kind === "ended" ? this.#phase.reason : this.#phase.kind;
  }

  get ended(): Ended | undefined {
    return this.#phase.kind === "ended" ? this.#phase.reason : undefined;
  }

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

  async run<R>(call: (opened: T) => Promise<R>): Promise<R> {
    this.#operations += 1;
    try {
      return await call(await this.#ready());
    } finally {
      this.#operations -= 1;
      this.touch();
    }
  }

  async *read<R>(stream: (opened: T) => AsyncIterable<R>): AsyncGenerator<R, void, undefined> {
    this.#readers += 1;
    try {
      yield* stream(await this.#ready());
    } finally {
      this.#readers -= 1;
      this.touch();
    }
  }

  touch(): void {
    const phase = this.#phase;
    const { clock, idleMs } = this.#options;
    if (phase.kind !== "open") return;
    phase.lastActivity = clock.now();
    if (idleMs === undefined || phase.cancelIdle !== undefined) return;
    phase.cancelIdle = clock.timer(() => void this.#checkIdle(phase, idleMs), idleMs, false);
  }

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
        opened = await openedDespiteTheEnd(phase.opening);
        break;
      case "closing":
        await phase.closing;
        break;
    }
    if (opened !== undefined) await this.#options.release(opened);
    this.#options.letGo();
  }

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

  #unused(): boolean {
    return this.#operations === 0 && this.#readers === 0;
  }

  #nothingDueWithinIdleTime(opened: T, idleMs: number): boolean {
    const { active, at } = this.#options.wake(opened);
    return !active && (at === undefined || at - this.#options.clock.now() > idleMs);
  }

  async #checkIdle(open: Open<T>, idleMs: number): Promise<void> {
    open.cancelIdle = undefined;
    if (this.#phase !== open || !this.#unused()) return;
    const { clock, arm } = this.#options;
    const left = open.lastActivity + idleMs - clock.now();
    if (left > 0) {
      open.cancelIdle = clock.timer(() => void this.#checkIdle(open, idleMs), left, false);
      return;
    }
    if (!this.#nothingDueWithinIdleTime(open.opened, idleMs)) {
      this.touch();
      return;
    }
    if (arm !== undefined) {
      try {
        await arm(this.#options.wake(open.opened));
      } catch (error) {
        this.#options.report("arm_failed", error);
        this.touch();
        return;
      }
      if (this.#phase !== open || open.cancelIdle !== undefined || !this.#unused()) return;
      if (open.lastActivity + idleMs > clock.now() || !this.#nothingDueWithinIdleTime(open.opened, idleMs)) {
        this.touch();
        return;
      }
    }
    this.#closeIdle(open.opened);
  }

  #closeIdle(opened: T) {
    const { at } = this.#options.wake(opened);
    let startRelease!: () => void;
    const closing = new Promise<void>((resolve) => (startRelease = resolve))
      .then(() => this.#options.release(opened))
      .finally(() => {
        if (this.#phase.kind !== "closing") return;
        if (at !== undefined && this.#options.arm === undefined) {
          this.#sleepUntil(at);
        } else {
          this.#phase = { kind: "dormant" };
          this.#options.letGo();
        }
      });
    this.#phase = { kind: "closing", closing };
    startRelease();
  }

  #sleepUntil(at: number) {
    const { clock } = this.#options;
    const fire = () => {
      if (at > clock.now()) {
        sleep.cancel = clock.timer(fire, at - clock.now(), true);
        return;
      }
      this.run(async () => undefined).catch((error: unknown) => {
        this.#options.report("reopen_failed", error);
        if (this.#phase.kind !== "dormant" || error instanceof LeaseHeldError) return;
        this.#sleepUntil(clock.now() + Math.min(Math.max(this.#options.idleMs ?? 0, 1_000), 60_000));
      });
    };
    const sleep: Sleep = { at, cancel: clock.timer(fire, at - clock.now(), true) };
    this.#phase = { kind: "dormant", sleep };
    this.#options.hold();
  }
}
