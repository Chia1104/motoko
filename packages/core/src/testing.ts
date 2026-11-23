/**
 * `@chia1104/motoko-core/testing`: the host contract as a suite that every `AgentHost` adapter runs against itself. It takes the
 * adapter's own test runner as `{ describe, expect, it }`, the shape pi-durable's `registerStorageConformance` takes,
 * so the core depends on no test framework and the suite runs wherever a host's tests run.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { commitWrites, createExpectAssertions } from "@earendil-works/pi-durable/testing";
import type { StorageConformanceRunner } from "@earendil-works/pi-durable/testing";

import { defineAgent } from "./agent.ts";
import { LeaseHeldError } from "./errors.ts";
import type { AgentHost, StorageScope } from "./host.ts";
import { createAgentRuntime } from "./runtime.ts";
import type { InstanceReport } from "./runtime.ts";

/** Calls `use` once with a host, then cleans up whatever the host holds (a directory, a database). */
export type HostConformanceProvider = (use: (host: AgentHost) => Promise<void>) => Promise<void>;

/**
 * Calls `use` once with a fresh host that serves one scope alone and with that scope, then cleans up. A scope no
 * earlier case used, as a fresh Durable Object's is.
 */
export type SingleScopeHostConformanceProvider = (
  use: (host: AgentHost, scope: StorageScope) => Promise<void>,
) => Promise<void>;

const context = BACKGROUND_CONTEXT;

/**
 * A scope no earlier case used. Cases may share one host's leases and storage (a process-wide lease table, one
 * database), and a case that fails can leave its lease held, so no two cases ever touch the same scope.
 */
const freshScope = (): StorageScope => ({ kind: "conformance", name: crypto.randomUUID() });

/** What `operation` rejects or throws with, or `undefined` when it settles without one. */
async function failureOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Every scope `unfinished()` lists. */
async function listed(host: AgentHost): Promise<StorageScope[]> {
  const scopes: StorageScope[] = [];
  for await (const scope of host.unfinished!()) scopes.push(scope);
  return scopes;
}

const sameScope = (a: StorageScope) => (b: StorageScope) => a.kind === b.kind && a.name === b.name;

/** One case of the host contract: `fresh()` is a scope no earlier case used, or the one scope a host serves. */
type HostCase = (host: AgentHost, fresh: () => StorageScope) => Promise<void>;

/** The cases of the host contract, for a host that serves every scope or, with `single`, one alone. */
function hostCases(runner: StorageConformanceRunner, single: boolean): Record<string, HostCase> {
  const assert = createExpectAssertions(runner.expect);
  const assertHeld = (error: unknown) =>
    assert.ok(error instanceof LeaseHeldError, `Expected a LeaseHeldError, got ${String(error)}`);

  return {
    async "refuses a second lease on a held scope with LeaseHeldError, and the holder keeps it"(host, fresh) {
      const scope = fresh();
      const holder = await host.lease(scope);
      assertHeld(await failureOf(() => host.lease(scope)));
      assert.strictEqual(holder.signal.aborted, false);
      await holder.release();
    },

    async "frees the scope on release, so the next lease succeeds"(host, fresh) {
      const scope = fresh();
      const first = await host.lease(scope);
      await first.release();
      const second = await host.lease(scope);
      assert.strictEqual(second.signal.aborted, false);
      await second.release();
    },

    async "releases once: a stale second release does not free the scope's next holder"(host, fresh) {
      const scope = fresh();
      const stale = await host.lease(scope);
      await stale.release();
      const holder = await host.lease(scope);
      await stale.release();
      assertHeld(await failureOf(() => host.lease(scope)));
      assert.strictEqual(holder.signal.aborted, false);
      await holder.release();
    },

    ...(single
      ? {
          async "refuses every scope but its own with a TypeError, also one a `/` away"(host, fresh) {
            const scope = fresh();
            for (const other of [
              { kind: scope.kind, name: `${scope.name}/x` },
              { kind: `${scope.kind}/x`, name: scope.name },
            ]) {
              const error = await failureOf(() => host.lease(other));
              assert.ok(
                error instanceof TypeError,
                `Expected a TypeError for ${JSON.stringify(other)}, got ${String(error)}`,
              );
            }
            const lease = await host.lease(scope);
            assert.strictEqual(lease.signal.aborted, false);
            await lease.release();
          },
        }
      : {
          async "keeps apart two scopes that differ only in where a `/` falls"(host) {
            const id = crypto.randomUUID();
            const left = { kind: `${id}/x`, name: "y" };
            const right = { kind: id, name: "x/y" };
            const leftLease = await host.lease(left);
            const rightLease = await host.lease(right);
            const leftStorage = await host.storage(left, leftLease);
            try {
              await commitWrites(leftStorage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
            } finally {
              await leftStorage.close(context);
            }
            const rightStorage = await host.storage(right, rightLease);
            try {
              assert.strictEqual(await rightStorage.conversation(ROOT_CONVERSATION_ID, context), undefined);
            } finally {
              await rightStorage.close(context);
            }
            await leftLease.release();
            await rightLease.release();
          },
        }),

    async "rejects an invalid scope with a TypeError"(host) {
      for (const scope of [
        { kind: "", name: "x" },
        { kind: "conformance", name: "a\0b" },
      ]) {
        const error = await failureOf(() => host.lease(scope));
        assert.ok(
          error instanceof TypeError,
          `Expected a TypeError for ${JSON.stringify(scope)}, got ${String(error)}`,
        );
      }
    },

    async "opens a usable storage under a held lease, whose signal stays unaborted"(host, fresh) {
      const scope = fresh();
      const lease = await host.lease(scope);
      const storage = await host.storage(scope, lease);
      try {
        await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
        assert.partialDeepEqual(await storage.conversation(ROOT_CONVERSATION_ID, context), {
          id: ROOT_CONVERSATION_ID,
        });
        assert.strictEqual(lease.signal.aborted, false);
      } finally {
        await storage.close(context);
      }
      await lease.release();
    },

    async "takes what an instance left at release, and frees the scope"(host, fresh) {
      const scope = fresh();
      const lease = await host.lease(scope);
      await lease.release({ active: true, at: Date.now() + 60_000 });
      const next = await host.lease(scope);
      assert.strictEqual(next.signal.aborted, false);
      await next.release({ active: false });
    },

    async "lists, with `unfinished`, a scope whose last open left work that can run, or a sleep"(host, fresh) {
      if (host.unfinished === undefined) return;
      const running = fresh();
      const sleeping = fresh();
      for (const [scope, wake] of [
        [running, { active: true }],
        [sleeping, { active: false, at: Date.now() + 60_000 }],
      ] as const) {
        const lease = await host.lease(scope);
        const storage = await host.storage(scope, lease);
        try {
          await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
        } finally {
          await storage.close(context);
        }
        await lease.release(wake);
      }
      const scopes = await listed(host);
      assert.ok(scopes.some(sameScope(running)), "Expected the scope left with work that can run");
      assert.ok(scopes.some(sameScope(sleeping)), "Expected the scope left with a sleep");
    },

    async "erases, with `erase`, a deleted session and what it owns, and keeps the others"(host, fresh) {
      if (host.erase === undefined) return;
      const reports: InstanceReport[] = [];
      const { kind, name } = fresh();
      const agent = defineAgent({ kind, instructions: "You answer.", tools: [] });
      const runtime = createAgentRuntime({
        agents: [agent],
        host,
        models: createModels(),
        ports: {},
        defaultModel: { provider: "conformance", modelId: "none" },
        onReport: (report) => reports.push(report),
      });
      let keptId = "";
      try {
        const instance = runtime.get(agent, name);
        const kept = await instance.createSession();
        keptId = kept.id;
        const doomed = await instance.createSession();
        await instance.session(doomed.id).delete();
        // The runtime hands the host the deleted session once the storage is closed.
        await instance.close();
        assert.deepEqual(reports, []);
        assert.deepEqual(await runtime.get(agent, name).listSessions(), [kept]);
        await runtime.get(agent, name).close();
      } finally {
        await runtime.close();
      }
      const scope = { kind, name };
      const lease = await host.lease(scope);
      const storage = await host.storage(scope, lease);
      try {
        const ids = (await storage.scanConversations({}, 10, undefined, context)).items.map((record) =>
          String(record.id),
        );
        assert.deepEqual(ids, [keptId]);
      } finally {
        await storage.close(context);
        await lease.release();
      }
    },
  };
}

/**
 * Registers the cases of the host contract (`AgentHost` and `Lease` in `host.ts`) under `name`: the single-writer
 * lease, its release, scope validation and storage opened under a held lease, and, for a host that has them,
 * `unfinished()` and `erase()`. Only what every host must do; an adapter's own guarantees (expiry, other processes,
 * fencing) stay in its own tests. Each case runs on scopes of its own, so one host may serve every case.
 */
export function registerHostConformance(
  runner: StorageConformanceRunner,
  name: string,
  withHost: HostConformanceProvider,
): void {
  const cases = hostCases(runner, false);
  runner.describe(name, () => {
    for (const [title, run] of Object.entries(cases)) runner.it(title, () => withHost((host) => run(host, freshScope)));
  });
}

/**
 * Registers the same cases for a host that serves one scope alone, as a Durable Object's serves the object's own:
 * every case runs on a fresh host and its scope, and the host must refuse every other scope with a `TypeError` in
 * place of keeping two scopes apart.
 */
export function registerSingleScopeHostConformance(
  runner: StorageConformanceRunner,
  name: string,
  withHost: SingleScopeHostConformanceProvider,
): void {
  const cases = hostCases(runner, true);
  runner.describe(name, () => {
    for (const [title, run] of Object.entries(cases)) {
      runner.it(title, () => withHost((host, scope) => run(host, () => scope)));
    }
  });
}
