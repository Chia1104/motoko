import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { eventually, pause, rejectionOf, unhandledRejections } from "./helpers.ts";
import { objectName } from "./worker.ts";

const fresh = (name: string = crypto.randomUUID()) => env.MOTOKO.getByName(name);

describe("an Agent with Motoko installed", () => {
  it("takes a submission over the object's RPC and finishes the run, a tool call included", async () => {
    const stub = fresh();
    await stub.script([{ tool: "shout", args: { text: "hi" } }, { text: "It said HI." }]);
    const session = await stub.createSession();
    await stub.submit(session, "Shout hi", "r-1");
    expect(await stub.transcript(session)).toEqual({
      messages: [
        { role: "user", text: "Shout hi" },
        { role: "assistant", text: "It said HI." },
      ],
      end: { reason: "done" },
    });
    expect(await stub.requests()).toBe(2);
    await eventually(async () => (await stub.wakeJob()) === null);
  });

  it("keeps the Agents SDK's scheduler and state working beside it, on the object's one alarm", async () => {
    const stub = fresh();
    await stub.scheduleNote("scheduled", 1);
    await stub.script([{ text: "Done." }]);
    const session = await stub.createSession();
    await stub.submit(session, "Hello", "r-1");
    expect((await stub.transcript(session)).end).toEqual({ reason: "done" });
    await eventually(async () => (await stub.wakeJob()) === null);
    expect(await stub.notes()).toEqual([]);
    await eventually(async () => (await stub.notes()).length > 0, 5_000);
    expect(await stub.notes()).toEqual(["scheduled"]);
  });
});

describe("with closeIdleAfterMs", () => {
  it("closes the idle instance, erasing a deleted session from the object's database, and reopens at a call", async () => {
    const stub = fresh(objectName("idle"));
    await stub.script([{ text: "Kept answer." }, { text: "Secret answer." }]);
    const kept = await stub.createSession();
    const doomed = await stub.createSession();
    for (const [session, text] of [
      [kept, "Kept question"],
      [doomed, "Secret question"],
    ] as const) {
      await stub.submit(session, text, text);
      expect((await stub.transcript(session)).end).toEqual({ reason: "done" });
    }
    expect(await stub.storedEntries(doomed)).toBeGreaterThan(0);

    await stub.deleteSession(doomed);
    await eventually(async () => (await stub.instanceState()) === "dormant");
    expect(await stub.storedEntries(doomed)).toBe(0);
    expect(await stub.storedEntries(kept)).toBeGreaterThan(0);
    expect(await stub.wakeJob()).toBeNull();
    expect(await stub.listSessions()).toEqual([kept]);
    expect(await stub.instanceState()).toBe("open");
  });
});

describe("an evicted object", () => {
  it("carries an interrupted run on from its alarm and job alone, with no further call", async () => {
    const name = crypto.randomUUID();
    const stub = fresh(name);
    await stub.script([{ hold: true }, { text: "Carried on." }]);
    const session = await stub.createSession();
    await stub.submit(session, "Work", "r-1");
    await eventually(async () => (await stub.requests()) === 1);

    await abortAllDurableObjects();
    await eventually(async () => (await fresh(name).requests()) === 2);
    expect(await fresh(name).transcript(session)).toEqual({
      messages: [
        { role: "user", text: "Work" },
        { role: "assistant", text: "Carried on." },
      ],
      end: { reason: "done" },
    });
  });

  it("runs a sleep it was evicted in at its time, from its alarm and job alone", async () => {
    const name = crypto.randomUUID();
    const stub = fresh(name);
    await stub.script([{ error: "503 service unavailable" }, { text: "Recovered." }]);
    const session = await stub.createSession();
    await stub.submit(session, "Work", "r-1");
    const at = await stub.retryAt(session);
    expect(at).toBeGreaterThan(Date.now());
    await eventually(async () => (await stub.wakeJob()) === at);

    await abortAllDurableObjects();
    await pause(at - Date.now() - 100);
    expect(await fresh(name).requests()).toBe(1);
    await eventually(async () => (await fresh(name).requests()) === 2);
    expect(await fresh(name).transcript(session)).toEqual({
      messages: [
        { role: "user", text: "Work" },
        { role: "assistant", text: "Recovered." },
      ],
      end: { reason: "done" },
    });
  });
});

describe("an ask from one object to another", () => {
  it("delivers the asked run's answer over RPC, tried again from the asked object's alarm alone", async () => {
    const [askerName, askedName] = [crypto.randomUUID(), crypto.randomUUID()];
    const asked = fresh(askedName);
    const askedSession = await asked.createSession();
    await asked.script([{ text: "Because." }]);
    await asked.failDeliveries(1);
    const asker = fresh(askerName);
    await asker.script([
      { tool: "relay", args: { to: askedName, session: askedSession, text: "Why?" } },
      { text: "It says because." },
    ]);
    const session = await asker.createSession();
    await asker.submit(session, "Ask", "r-1");
    await eventually(async () => (await fresh(askedName).deliveries()).length === 1);

    await abortAllDurableObjects();
    await eventually(async () => (await fresh(askedName).deliveries()).length === 2);
    expect(await fresh(askedName).deliveries()).toEqual(["failed", "applied"]);
    expect(await fresh(askerName).transcript(session)).toEqual({
      messages: [
        { role: "user", text: "Ask" },
        { role: "assistant", text: "It says because." },
      ],
      end: { reason: "done" },
    });
    expect((await fresh(askedName).transcript(askedSession)).messages).toEqual([
      { role: "user", text: "Why?" },
      { role: "assistant", text: "Because." },
    ]);
  });
});

describe("an object whose scope's lease another writer holds", () => {
  it("refuses an RPC call with core's LeaseHeldError, leaving no rejection unhandled", async () => {
    const name = objectName("held");
    const stub = fresh(name);
    await stub.holdLease(true);
    let refusal: unknown;
    const unhandled = await unhandledRejections(async () => {
      refusal = await rejectionOf(stub.createSession());
    });
    expect(unhandled).toEqual([]);
    // Over RPC the error keeps its own fields, its name among them, though not its class.
    expect(refusal).toMatchObject({
      name: "LeaseHeldError",
      message: `Another writer holds agent instance assistant/${name}`,
      scope: { kind: "assistant", name },
    });
  });

  it("has its wake job try again later, leaving no rejection unhandled, and completes it once the lease is free", async () => {
    const stub = fresh(objectName("held"));
    await stub.holdLease(true);
    const unhandled = await unhandledRejections(async () => {
      await stub.armActive();
      const armed = (await stub.wakeJob())!;
      await eventually(async () => ((await stub.wakeJob()) ?? 0) > armed);
      await stub.holdLease(false);
      await eventually(async () => (await stub.wakeJob()) === null);
    });
    expect(unhandled).toEqual([]);
  });
});

describe("the wake job", () => {
  it("completes when it finds nothing to do, though it was armed for work", async () => {
    const stub = fresh();
    await stub.createSession();
    await eventually(async () => (await stub.wakeJob()) === null);
    await stub.armActive();
    expect(await stub.wakeJob()).not.toBeNull();
    await eventually(async () => (await stub.wakeJob()) === null, 3_000);
  });

  it("stays while a call that can start work waits on its commit, though its own run found nothing to do", async () => {
    const stub = fresh(objectName("gated"));
    await stub.script([{ text: "Done." }]);
    const session = await stub.createSession();
    await eventually(async () => (await stub.wakeJob()) === null);

    await stub.holdNextCommit();
    const submitted = stub.submit(session, "Work", "r-1");
    await eventually(() => stub.commitHeld());
    const armed = (await stub.wakeJob())!;
    await eventually(async () => (await stub.wakeJob()) !== armed);
    const job = await stub.wakeJob();
    expect(job).not.toBeNull();
    expect(job).toBeGreaterThan(armed);

    await stub.releaseCommit();
    expect(await submitted).toEqual(expect.any(String));
    expect((await stub.transcript(session)).end).toEqual({ reason: "done" });
    await eventually(async () => (await stub.wakeJob()) === null);
  });

  it("waits on running work at most its budget in one alarm, then waits on in a fresh one", async () => {
    const stub = fresh();
    await stub.wakeTiming({ heartbeatMs: 60_000, waitBudgetMs: 300 });
    await stub.script([{ hold: true }]);
    const session = await stub.createSession();
    await stub.submit(session, "Work", "r-1");
    await eventually(async () => (await stub.requests()) === 1);
    await eventually(async () => ((await stub.wakeJob()) ?? 0) > Date.now() + 30_000);
    const first = (await stub.wakeJob())!;
    await eventually(async () => ((await stub.wakeJob()) ?? 0) > first);
    expect(await stub.release("Finally.")).toBe(true);
    expect((await stub.transcript(session)).end).toEqual({ reason: "done" });
    await eventually(async () => (await stub.wakeJob()) === null);
  });
});
