// An object cannot be made to dispose while a step's `resume()` is under way: once the instance is open, a resume
// awaits I/O only in the app's `modelsFor`, and an instance closed in that time refuses the rest of the resume. So this
// file drives the wake loop itself, with a fake of the capability's side.
import type { Wake } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vite-plus/test";

import type { AgentInstance, AgentRuntime } from "@chia1104/motoko-core";

import { WakeLoop } from "../src/wake.ts";
import type { WakeTarget } from "../src/wake.ts";

import { pause } from "./helpers.ts";

/** The capability's side of the loop. Its instance's `resume()` waits for `finishResume()`. */
class Capability implements WakeTarget {
  readonly scheduled: Wake[] = [];
  resumes = 0;
  #runtime: AgentRuntime | undefined;
  #finishResume: () => void = () => undefined;
  readonly #instance = { resume: () => this.#resume() } as AgentInstance;

  runtime(): AgentRuntime | undefined {
    return this.#runtime;
  }

  instance(): AgentInstance {
    this.#runtime ??= {} as AgentRuntime;
    return this.#instance;
  }

  schedule(wake: Wake): Promise<void> {
    this.scheduled.push(wake);
    return Promise.resolve();
  }

  trackAlarmWork(): boolean {
    return false;
  }

  /** What `dispose()` does to the loop. */
  dispose(loop: WakeLoop): void {
    this.#runtime = undefined;
    loop.runtimeClosed();
  }

  finishResume(): void {
    this.#finishResume();
  }

  #resume(): Promise<void> {
    this.resumes += 1;
    return new Promise((resolve) => {
      this.#finishResume = resolve;
    });
  }
}

describe("the wake loop, when the runtime closes while a step resumes the instance", () => {
  it("ends the step's wait at once and leaves the job as it was, so the next step resumes the instance", async () => {
    const capability = new Capability();
    const loop = new WakeLoop(capability);
    loop.timing = { waitBudgetMs: 50, heartbeatMs: 1_000 };
    const stepped = loop.step();
    await loop.arm({ active: true });
    capability.dispose(loop);
    capability.finishResume();
    expect(await stepped).toEqual({ rescheduleAt: expect.any(Number) });

    await pause(200);
    expect(capability.scheduled).toEqual([]);

    const next = loop.step();
    expect(capability.resumes).toBe(2);
    await loop.arm({ active: false });
    capability.finishResume();
    expect(await next).toBeUndefined();
  });
});
