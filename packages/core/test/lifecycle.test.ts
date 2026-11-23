// An instance's lifecycle on a clock that moves only when the test moves it: every transition,
// race and timer is driven step by step, with no real wait.

import type { Wake } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vite-plus/test";

import { InstanceLifecycle } from "../src/engine/lifecycle.ts";
import type { Clock } from "../src/engine/lifecycle.ts";
import { InstanceClosedError, LeaseHeldError } from "../src/index.ts";

const IDLE = 1_000;
const scope = { kind: "notes", name: "a" };

/** Lets every promise chain started so far run until it waits on something outside it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A clock that moves only when the test moves it. */
class TestClock implements Clock {
  #now = 1_000_000;
  readonly #timers = new Set<{ readonly at: number; readonly callback: () => void; readonly keepAlive: boolean }>();

  now(): number {
    return this.#now;
  }

  timer(callback: () => void, ms: number, keepAlive: boolean): () => void {
    const timer = { at: this.#now + Math.max(ms, 0), callback, keepAlive };
    this.#timers.add(timer);
    return () => void this.#timers.delete(timer);
  }

  /** The timers waiting, by when they are due. */
  pending(): { at: number; keepAlive: boolean }[] {
    return [...this.#timers].map(({ at, keepAlive }) => ({ at, keepAlive })).sort((a, b) => a.at - b.at);
  }

  /** Moves time on by `ms`, firing each timer as its time comes, and lets what each sets off settle. */
  async advance(ms: number): Promise<void> {
    const until = this.#now + ms;
    for (;;) {
      await settle();
      const [next] = [...this.#timers].filter(({ at }) => at <= until).sort((a, b) => a.at - b.at);
      if (next === undefined) break;
      this.#timers.delete(next);
      this.#now = next.at;
      next.callback();
    }
    this.#now = until;
    await settle();
  }
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Opened {
  readonly n: number;
}

/**
 * A lifecycle over a scripted instance: each open, release and arm is logged, and a test holds or
 * fails one by setting its step in `script`. `held()` is whether the runtime keeps the instance.
 */
function world(options: { idleMs?: number | undefined; alarm?: boolean } = {}) {
  const clock = new TestClock();
  const log: string[] = [];
  const reports: { kind: string; error: unknown }[] = [];
  const script: {
    wake: Wake;
    open?: () => Promise<void>;
    release?: () => Promise<void>;
    arm?: () => Promise<void>;
  } = { wake: { active: false } };
  let held = false;
  let opens = 0;
  const lifecycle = new InstanceLifecycle<Opened>({
    scope,
    clock,
    idleMs: "idleMs" in options ? options.idleMs : IDLE,
    async open() {
      opens += 1;
      const n = opens;
      log.push(`open ${n}`);
      await script.open?.();
      return { n };
    },
    async release({ n }) {
      log.push(`release ${n}`);
      await script.release?.();
    },
    wake: () => script.wake,
    arm: options.alarm
      ? async (wake) => {
          log.push(`arm ${wake.at ?? "-"}`);
          await script.arm?.();
        }
      : undefined,
    report: (kind, error) => reports.push({ kind, error }),
    hold: () => {
      held = true;
    },
    letGo: () => {
      held = false;
    },
  });
  return { lifecycle, clock, log, reports, script, held: () => held };
}

/** Opens the instance, then closes it for idleness with a sleep due at `at`. */
async function closedWithSleep({ lifecycle, clock, script }: ReturnType<typeof world>, at: number) {
  await lifecycle.run(async () => undefined);
  script.wake = { active: false, at };
  await clock.advance(IDLE);
  expect(lifecycle.state).toBe("dormant");
}

describe("opening", () => {
  it("opens at the first call, which runs against what the open made, and later calls share it", async () => {
    const { lifecycle, log, held } = world();
    expect(lifecycle.state).toBe("dormant");
    const first = lifecycle.run(async ({ n }) => n);
    expect(lifecycle.state).toBe("opening");
    expect(held()).toBe(true);
    const second = lifecycle.run(async ({ n }) => n);
    expect([await first, await second]).toEqual([1, 1]);
    expect(lifecycle.state).toBe("open");
    expect(lifecycle.opened).toEqual({ n: 1 });
    expect(await lifecycle.run(async ({ n }) => n)).toBe(1);
    expect(log).toEqual(["open 1"]);
  });

  it("fails the calls waiting on a failed open, lets the instance go dormant, and opens again at the next call", async () => {
    const { lifecycle, log, script, held } = world();
    script.open = async () => {
      throw new LeaseHeldError(scope);
    };
    const calls = [lifecycle.run(async () => "a"), lifecycle.run(async () => "b")];
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(LeaseHeldError);
    expect(lifecycle.state).toBe("dormant");
    expect(held()).toBe(false);

    delete script.open;
    expect(await lifecycle.run(async ({ n }) => n)).toBe(2);
    expect(log).toEqual(["open 1", "open 2"]);
  });
});

describe("an idle close", () => {
  it("comes a whole idle time after the last call ends, on a timer that keeps no process alive", async () => {
    const { lifecycle, clock, log, held } = world();
    await lifecycle.run(async () => undefined);
    expect(clock.pending()).toEqual([{ at: clock.now() + IDLE, keepAlive: false }]);
    await clock.advance(IDLE - 1);
    expect(lifecycle.state).toBe("open");
    await clock.advance(1);
    expect(lifecycle.state).toBe("dormant");
    expect(lifecycle.opened).toBeUndefined();
    expect(log).toEqual(["open 1", "release 1"]);
    expect(held()).toBe(false);
    expect(clock.pending()).toEqual([]);
  });

  it("counts the quiet period from the last activity", async () => {
    const { lifecycle, clock } = world();
    await lifecycle.run(async () => undefined);
    await clock.advance(IDLE / 2);
    lifecycle.touch();
    await clock.advance(IDLE - 1);
    expect(lifecycle.state).toBe("open");
    await clock.advance(1);
    expect(lifecycle.state).toBe("dormant");
  });

  it("waits while a call is under way or a reader is attached, and comes a whole idle time after either ends", async () => {
    const { lifecycle, clock } = world();
    const call = deferred();
    const running = lifecycle.run(() => call.promise);
    await clock.advance(IDLE * 5);
    expect(lifecycle.inspection()).toMatchObject({ state: "open", operations: 1, readers: 0 });
    call.resolve();
    await running;

    const reader = lifecycle.read(async function* ({ n }) {
      yield n;
      yield n;
    });
    expect(await reader.next()).toEqual({ value: 1, done: false });
    await clock.advance(IDLE * 5);
    expect(lifecycle.inspection()).toMatchObject({ state: "open", operations: 0, readers: 1 });
    await reader.return(undefined);
    expect(lifecycle.inspection().readers).toBe(0);
    await clock.advance(IDLE - 1);
    expect(lifecycle.state).toBe("open");
    await clock.advance(1);
    expect(lifecycle.state).toBe("dormant");
  });

  it("waits while work can run or a sleep is due within the idle time", async () => {
    const { lifecycle, clock, log, script } = world();
    await lifecycle.run(async () => undefined);
    script.wake = { active: true };
    await clock.advance(IDLE * 3);
    script.wake = { active: false, at: clock.now() + IDLE };
    await clock.advance(IDLE * 3);
    expect(lifecycle.state).toBe("open");
    expect(log).toEqual(["open 1"]);
    script.wake = { active: false };
    await clock.advance(IDLE);
    expect(lifecycle.state).toBe("dormant");
    expect(log).toEqual(["open 1", "release 1"]);
  });

  it("never comes without an idle time", async () => {
    const { lifecycle, clock } = world({ idleMs: undefined });
    await lifecycle.run(async () => undefined);
    await clock.advance(IDLE * 1_000);
    expect(lifecycle.state).toBe("open");
    expect(clock.pending()).toEqual([]);
  });

  it("holds a call that comes meanwhile until the release is done, then opens anew", async () => {
    const { lifecycle, clock, log, script, held } = world();
    await lifecycle.run(async () => undefined);
    const releasing = deferred();
    script.release = () => releasing.promise;
    await clock.advance(IDLE);
    expect(lifecycle.state).toBe("closing");
    expect(held()).toBe(true);

    const call = lifecycle.run(async ({ n }) => n);
    await clock.advance(IDLE * 2);
    expect(lifecycle.state).toBe("closing");
    expect(log).toEqual(["open 1", "release 1"]);
    releasing.resolve();
    expect(await call).toBe(2);
    expect(lifecycle.state).toBe("open");
    expect(log).toEqual(["open 1", "release 1", "open 2"]);
  });
});

describe("without an alarm host, a sleep the instance was closed with", () => {
  it("keeps it dormant and held until the sleep is due, then reopens it, and lets go once nothing is due", async () => {
    const env = world();
    const { lifecycle, clock, log, script, held } = env;
    const at = clock.now() + IDLE * 10;
    await closedWithSleep(env, at);
    expect(lifecycle.inspection()).toEqual({ scope, state: "dormant", operations: 0, readers: 0, wakeAt: at });
    expect(held()).toBe(true);
    expect(clock.pending()).toEqual([{ at, keepAlive: true }]);

    script.wake = { active: false };
    await clock.advance(at - clock.now() - 1);
    expect(log).toEqual(["open 1", "release 1"]);
    await clock.advance(1);
    expect(lifecycle.state).toBe("open");
    expect(lifecycle.inspection().wakeAt).toBeUndefined();
    expect(log).toEqual(["open 1", "release 1", "open 2"]);
    await clock.advance(IDLE);
    expect(lifecycle.state).toBe("dormant");
    expect(held()).toBe(false);
    expect(log).toEqual(["open 1", "release 1", "open 2", "release 2"]);
  });

  it("is reopened by a call that comes first, which cancels the reopen for it", async () => {
    const env = world();
    const { lifecycle, clock, log, script } = env;
    const at = clock.now() + IDLE * 10;
    await closedWithSleep(env, at);
    expect(await lifecycle.run(async ({ n }) => n)).toBe(2);
    expect(lifecycle.inspection().wakeAt).toBeUndefined();
    expect(clock.pending().every(({ keepAlive }) => !keepAlive)).toBe(true);
    // The call ran what was due: the instance closes once idle, and the old sleep never reopens it.
    script.wake = { active: false };
    await clock.advance(at - clock.now() + IDLE);
    expect(log).toEqual(["open 1", "release 1", "open 2", "release 2"]);
  });

  it("is left to the writer that holds the scope when it is due: the instance lets go", async () => {
    const env = world();
    const { lifecycle, clock, script, reports, held } = env;
    const at = clock.now() + IDLE * 10;
    await closedWithSleep(env, at);
    script.open = async () => {
      throw new LeaseHeldError(scope);
    };
    await clock.advance(at - clock.now());
    expect(reports).toEqual([{ kind: "reopen_failed", error: expect.any(LeaseHeldError) }]);
    expect(lifecycle.inspection()).toEqual({ scope, state: "dormant", operations: 0, readers: 0 });
    expect(held()).toBe(false);
    expect(clock.pending()).toEqual([]);
  });

  it("is reopened again later when the reopen fails otherwise: the idle time, a second at least", async () => {
    const env = world({ idleMs: 50 });
    const { lifecycle, clock, log, script, reports, held } = env;
    await lifecycle.run(async () => undefined);
    const at = clock.now() + 500;
    script.wake = { active: false, at };
    await clock.advance(50);
    expect(lifecycle.inspection().wakeAt).toBe(at);

    script.open = async () => {
      throw new Error("storage down");
    };
    await clock.advance(at - clock.now());
    expect(reports).toEqual([{ kind: "reopen_failed", error: expect.objectContaining({ message: "storage down" }) }]);
    expect(lifecycle.inspection()).toMatchObject({ state: "dormant", wakeAt: at + 1_000 });
    expect(held()).toBe(true);

    delete script.open;
    script.wake = { active: false };
    await clock.advance(1_000);
    expect(lifecycle.state).toBe("open");
    expect(log).toEqual(["open 1", "release 1", "open 2", "open 3"]);
  });
});

describe("with an alarm host", () => {
  it("arms the host with what is due before the close, and keeps nothing for the sleep", async () => {
    const { lifecycle, clock, log, script, held } = world({ alarm: true });
    await lifecycle.run(async () => undefined);
    const at = clock.now() + IDLE * 10;
    script.wake = { active: false, at };
    await clock.advance(IDLE);
    expect(log).toEqual(["open 1", `arm ${at}`, "release 1"]);
    expect(lifecycle.inspection()).toEqual({ scope, state: "dormant", operations: 0, readers: 0 });
    expect(held()).toBe(false);
    expect(clock.pending()).toEqual([]);
  });

  it("stays open while the host cannot be armed, reporting each failure, and closes once it can", async () => {
    const { lifecycle, clock, log, script, reports } = world({ alarm: true });
    await lifecycle.run(async () => undefined);
    script.arm = async () => {
      throw new Error("alarm unavailable");
    };
    await clock.advance(IDLE * 2);
    expect(lifecycle.state).toBe("open");
    expect(reports).toEqual([
      { kind: "arm_failed", error: expect.objectContaining({ message: "alarm unavailable" }) },
      { kind: "arm_failed", error: expect.objectContaining({ message: "alarm unavailable" }) },
    ]);

    delete script.arm;
    await clock.advance(IDLE);
    expect(lifecycle.state).toBe("dormant");
    expect(log).toEqual(["open 1", "arm -", "arm -", "arm -", "release 1"]);
  });

  it("calls the close off for a call that comes while the host arms, until a whole quiet period after it", async () => {
    const { lifecycle, clock, log, script } = world({ alarm: true });
    await lifecycle.run(async () => undefined);
    const arming = deferred();
    script.arm = () => arming.promise;
    await clock.advance(IDLE);
    expect(log).toEqual(["open 1", "arm -"]);

    await clock.advance(IDLE / 2);
    await lifecycle.run(async () => undefined);
    delete script.arm;
    arming.resolve();
    await clock.advance(IDLE - 1);
    expect(lifecycle.state).toBe("open");
    await clock.advance(1);
    expect(lifecycle.state).toBe("dormant");
    expect(log).toEqual(["open 1", "arm -", "arm -", "release 1"]);
  });

  it("calls the close off for a reader that attaches, or work that comes due, while the host arms", async () => {
    const { lifecycle, clock, script } = world({ alarm: true });
    await lifecycle.run(async () => undefined);
    let arming = deferred();
    script.arm = () => arming.promise;
    await clock.advance(IDLE);
    const reader = lifecycle.read(async function* ({ n }) {
      yield n;
      yield n;
    });
    await reader.next();
    arming.resolve();
    await clock.advance(IDLE * 3);
    expect(lifecycle.state).toBe("open");

    arming = deferred();
    await reader.return(undefined);
    await clock.advance(IDLE);
    script.wake = { active: true };
    arming.resolve();
    await clock.advance(0);
    expect(lifecycle.state).toBe("open");
    delete script.arm;
    script.wake = { active: false };
    await clock.advance(IDLE);
    expect(lifecycle.state).toBe("dormant");
  });

  it("lets an end that comes while the host arms release the open, once", async () => {
    const { lifecycle, clock, log, script } = world({ alarm: true });
    await lifecycle.run(async () => undefined);
    const arming = deferred();
    script.arm = () => arming.promise;
    await clock.advance(IDLE);
    await lifecycle.end("closed");
    arming.resolve();
    await clock.advance(IDLE);
    expect(lifecycle.state).toBe("closed");
    expect(log).toEqual(["open 1", "arm -", "release 1"]);
  });
});

describe("an end", () => {
  it("fails every later call and reader with InstanceClosedError and how it ended; the first end stands", async () => {
    const { lifecycle } = world();
    await lifecycle.end("lease_lost");
    await lifecycle.end("closed");
    expect(lifecycle.state).toBe("lease_lost");
    expect(lifecycle.ended).toBe("lease_lost");
    const closed = expect.objectContaining({ name: "InstanceClosedError", reason: "lease_lost" });
    await expect(lifecycle.run(async () => undefined)).rejects.toEqual(closed);
    const reader = lifecycle.read(async function* () {
      yield 1;
    });
    await expect(reader.next()).rejects.toEqual(closed);
  });

  it("releases an open instance's open and cancels its idle check", async () => {
    const { lifecycle, clock, log, held } = world();
    await lifecycle.run(async () => undefined);
    await lifecycle.end("closed");
    expect(log).toEqual(["open 1", "release 1"]);
    expect(held()).toBe(false);
    expect(clock.pending()).toEqual([]);
  });

  it("cancels a dormant instance's reopen for its sleep and lets it go", async () => {
    const env = world();
    const { lifecycle, clock, log, held } = env;
    await closedWithSleep(env, clock.now() + IDLE * 10);
    await lifecycle.end("closed");
    expect(held()).toBe(false);
    expect(clock.pending()).toEqual([]);
    expect(log).toEqual(["open 1", "release 1"]);
  });

  it("comes at once while the instance opens, and the instance is let go once the open has finished", async () => {
    const { lifecycle, log, script, held } = world();
    const opening = deferred();
    // As an instance's open does, this one checks for an end before it writes.
    script.open = async () => {
      await opening.promise;
      if (lifecycle.ended !== undefined) throw new InstanceClosedError(scope, lifecycle.ended);
    };
    const call = lifecycle.run(async () => undefined);
    const ending = lifecycle.end("closed");
    expect(lifecycle.state).toBe("closed");
    expect(held()).toBe(true);
    opening.resolve();
    await expect(call).rejects.toBeInstanceOf(InstanceClosedError);
    await ending;
    expect(held()).toBe(false);
    // The open let go of what it took itself.
    expect(log).toEqual(["open 1"]);
  });

  it("releases what an open past its check made, once that open finishes, and runs no call on it", async () => {
    const { lifecycle, log, script } = world();
    const opening = deferred();
    script.open = () => opening.promise;
    const call = lifecycle.run(async ({ n }) => void log.push(`call ${n}`));
    const ending = lifecycle.end("closed");
    opening.resolve();
    await ending;
    await expect(call).rejects.toBeInstanceOf(InstanceClosedError);
    expect(log).toEqual(["open 1", "release 1"]);
  });

  it("waits for an idle close under way, and stays ended: no reopen for its sleep", async () => {
    const { lifecycle, clock, script, held } = world();
    await lifecycle.run(async () => undefined);
    const releasing = deferred();
    script.release = () => releasing.promise;
    script.wake = { active: false, at: clock.now() + IDLE * 10 };
    await clock.advance(IDLE);
    expect(lifecycle.state).toBe("closing");

    let done = false;
    const ending = lifecycle.end("closed").then(() => {
      done = true;
    });
    expect(lifecycle.state).toBe("closed");
    await clock.advance(0);
    // The runtime keeps it until the lease is free.
    expect(done).toBe(false);
    expect(held()).toBe(true);
    releasing.resolve();
    await ending;
    expect(lifecycle.inspection()).toEqual({ scope, state: "closed", operations: 0, readers: 0 });
    expect(held()).toBe(false);
    expect(clock.pending()).toEqual([]);
  });
});
