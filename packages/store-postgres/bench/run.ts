// The remote-database benchmark: the runtime's public API (`createAgentRuntime` over `nodeHost`)
// on MemoryStorage, SQLite and Postgres, the last through a proxy that delays every byte by a set round trip. Run with
// `pnpm bench`; see README.md.
//
// Environment:
//   BENCH_DATABASE_URL  a Postgres URL (any database; the benchmark creates and drops one of its own).
//                       Without it, only MemoryStorage and SQLite run.
//   BENCH_RTTS          round trips to simulate, ms (default 0,2,10,40)
//   BENCH_REPS          measured repetitions per scenario (default 7; one more unmeasured warm-up runs first)
//   BENCH_BACKENDS      memory,sqlite,direct,postgres (default all; `direct` is Postgres without the proxy)
//   BENCH_TPS           tokens per second the model streams at (default 100)
//   BENCH_PROGRESS      pi-durable settings.progress for the runtime, e.g. partialIntervalMs=500,persistWithinMs=1000
//                       (the runtime passes `settings` through to pi-durable)
//   BENCH_POOL_MAX      pg pool size (default 10, pg's default)
//   BENCH_OUT           where to write the JSON results (default bench/results/<timestamp>.json)
//   BENCH_ONLY          comma-separated scenario prefixes to run (default all)
//   BENCH_CONCURRENT    also run that many instances streaming a turn at once (default 0: not run)

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import pg from "pg";

import { createAgentRuntime, inProcessLeases } from "@chia1104/motoko-core";
import type { AgentHost, AgentRuntime, AgentSession } from "@chia1104/motoko-core";
import { nodeHost, sqliteStorage } from "@chia1104/motoko-node";

import { createPostgresStore, migrate } from "../src/index.ts";

import { agent, answer, benchModels, deltaTimings, gatedCall, Reader, threeLookups } from "./fixtures.ts";
import { Meter, tally } from "./meter.ts";
import type { Window } from "./meter.ts";
import { DelayProxy } from "./proxy.ts";
import { printReport } from "./report.ts";
import type { Results, Sample } from "./report.ts";

const env = process.env;
const DATABASE_URL = env.BENCH_DATABASE_URL;
const RTTS = (env.BENCH_RTTS ?? "0,2,10,40").split(",").map(Number);
const REPS = Number(env.BENCH_REPS ?? 7);
const TPS = Number(env.BENCH_TPS ?? 100);
const POOL_MAX = Number(env.BENCH_POOL_MAX ?? 10);
const BACKENDS = new Set((env.BENCH_BACKENDS ?? "memory,sqlite,direct,postgres").split(","));
const ONLY = env.BENCH_ONLY?.split(",");
const PROGRESS = env.BENCH_PROGRESS
  ? Object.fromEntries(
      env.BENCH_PROGRESS.split(",").map((pair) => {
        const [key, value] = pair.split("=");
        return [key, Number(value)];
      }),
    )
  : undefined;

const CONCURRENT = Number(env.BENCH_CONCURRENT ?? 0);
const ANSWER_TOKENS = 300;
const SHORT_TOKENS = 100;
const SESSIONS = 50;
const HISTORY_TURNS = 150;

const meter = new Meter();
meter.instrumentHarness(Harness);
const { models, paced, fast } = benchModels(TPS);

interface Target {
  /** `memory`, `sqlite`, `postgres direct`, `postgres 10ms`, ... */
  readonly label: string;
  readonly backend: "memory" | "sqlite" | "postgres";
  readonly rttMs: number | undefined;
  readonly host: AgentHost;
  /** Prefix that keeps this target's scopes apart from another target's on the same database. */
  readonly prefix: string;
  /** Scopes holding fixtures several targets share (Postgres at every RTT). */
  readonly fixturePrefix: string;
}

const wants = (scenario: string) => ONLY === undefined || ONLY.some((prefix) => scenario.startsWith(prefix));

const median = (values: readonly number[]) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

const quantile = (values: readonly number[], q: number) => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};

function newRuntime(target: Target): AgentRuntime {
  const options = {
    agents: [agent],
    host: target.host,
    models,
    ports: {},
    defaultModel: paced.model,
    ...(PROGRESS !== undefined && { settings: { progress: PROGRESS } }),
  };
  return createAgentRuntime(options as Parameters<typeof createAgentRuntime>[0]);
}

const quietMs = (target: Target) => Math.max(40, 4 * (target.rttMs ?? 0));

/** The counts of one measured window. */
function counts(window: Window) {
  const statements = window.statements.filter((statement) => statement.kind !== "lease.renew");
  return {
    statements: statements.length,
    renewals: window.statements.length - statements.length,
    storageCalls: window.storageCalls.length,
    commits: window.storageCalls.filter((call) => call.method === "commit").length,
    maxInFlight: window.maxInFlight,
    byKind: Object.fromEntries(tally(statements, (statement) => statement.kind)),
    byCaller: Object.fromEntries(tally(statements, (statement) => `${statement.kind} ← ${statement.caller}`)),
    callsByMethod: Object.fromEntries(tally(window.storageCalls, (call) => call.method)),
    callsByCaller: Object.fromEntries(
      tally(
        window.storageCalls,
        (call) => `${call.method} ← ${call.caller}${call.writes === undefined ? "" : ` [${call.writes}]`}`,
      ),
    ),
    runtimeCalls: Object.fromEntries(tally(window.runtimeCalls, (call) => call.call)),
  };
}

/** Runs `work` as one measured window; its wall time is until `work` resolves. */
async function measure(
  target: Target,
  scenario: string,
  samples: Sample[],
  rep: number,
  work: () => Promise<Record<string, number> | void>,
): Promise<void> {
  await meter.quiet(quietMs(target));
  const window = meter.open();
  const start = performance.now();
  const extra = (await work()) ?? {};
  // A scenario that ends on settling rather than on a result reports its own wall time.
  const wallMs = extra.wallMs ?? performance.now() - start;
  delete extra.wallMs;
  await meter.quiet(quietMs(target));
  if (rep < 0) {
    window.close();
    return;
  }
  samples.push({ target: target.label, scenario, rep, wallMs, ...counts(window.close()), metrics: extra });
}

/** One turn on a session whose reader is attached: submit, stream, run end. */
async function turn(
  target: Target,
  session: AgentSession,
  reader: Reader,
  kind: "plain" | "tools" | "approval",
  samples: Sample[],
  rep: number,
) {
  const responses =
    kind === "plain"
      ? [answer(ANSWER_TOKENS)]
      : kind === "tools"
        ? [threeLookups(), answer(SHORT_TOKENS)]
        : [gatedCall(), answer(SHORT_TOKENS)];
  paced.setResponses(responses);
  const from = reader.arrivals.length;
  const emitted = paced.emissions.length;
  await measure(target, `turn.${kind}`, samples, rep, async () => {
    const start = performance.now();
    await session.submit({ text: `question ${kind} ${rep}`, requestId: crypto.randomUUID() });
    const submitMs = performance.now() - start;
    const metrics: Record<string, number> = { submitMs };
    if (kind === "approval") {
      const request = await reader.waitFor(from, (event) => event.type === "approval:request");
      metrics.approvalRequestMs = request.at - start;
      const event = request.item.event;
      if (event.type !== "approval:request") throw new Error("unreachable");
      const approving = performance.now();
      await session.approve([{ toolCallId: event.toolCallId, approved: true }]);
      metrics.approveMs = performance.now() - approving;
      const ended = await reader.waitFor(request.index, (next) => next.type === "tool:end");
      metrics.approveToToolEndMs = ended.at - approving;
    }
    const end = await reader.waitFor(from, (event) => event.type === "run:end");
    if (end.item.event.type === "run:end" && end.item.event.reason !== "done") {
      throw new Error(`run ended ${JSON.stringify(end.item.event)}`);
    }
    const { times, gaps, lags } = deltaTimings(
      reader.arrivals.slice(0, end.index + 1),
      from,
      paced.emissions.slice(emitted),
    );
    const firstRequest = paced.emissions[emitted]?.requestedAt;
    const lastRequest = paced.emissions.at(-1)?.requestedAt;
    Object.assign(metrics, {
      runEndMs: end.at - start,
      modelRequestMs: firstRequest === undefined ? Number.NaN : firstRequest - start,
      firstDeltaMs: times[0] === undefined ? Number.NaN : times[0] - start,
      deltas: times.length,
      gapP50Ms: median(gaps),
      gapP95Ms: quantile(gaps, 0.95),
      gapMaxMs: gaps.length === 0 ? Number.NaN : Math.max(...gaps),
      lagP50Ms: median(lags),
      lagP95Ms: quantile(lags, 0.95),
      lagMaxMs: lags.length === 0 ? Number.NaN : Math.max(...lags),
      // Last model request (the answer, after any tool round) to the run's end at the reader.
      answerToEndMs: lastRequest === undefined ? Number.NaN : end.at - lastRequest,
    });
    if (kind !== "approval" && kind !== "plain") {
      // Model's tool-call reply requested to the answer's request: the tool round.
      const second = paced.emissions[emitted + 1]?.requestedAt;
      if (firstRequest !== undefined && second !== undefined) metrics.toolRoundMs = second - firstRequest;
    }
    return metrics;
  });
  if (paced.pending() !== 0) throw new Error(`${paced.pending()} faux responses left over`);
}

/** Opening an instance, a session, its reader, three turns, and opening the instance again in a new runtime. */
async function sessionScenarios(target: Target, samples: Sample[], rep: number) {
  const name = `${target.prefix}-s${rep}`;
  let runtime = newRuntime(target);
  let instance = runtime.get(agent, name);
  await measure(target, "open.first", samples, rep, () => instance.open());
  let sessionId = "";
  await measure(target, "createSession", samples, rep, async () => {
    sessionId = (await instance.createSession()).id;
  });
  const session = instance.session(sessionId);
  let reader: Reader | undefined;
  await measure(target, "events.attachEmpty", samples, rep, async () => {
    const start = performance.now();
    const calls = meter.runtimeCalls.length;
    reader = new Reader(session);
    // An empty session sends nothing: the attach is done once its watch is observing the conversation and the
    // statements that caused have settled.
    while (!meter.runtimeCalls.slice(calls).some((call) => call.call.endsWith("harness.observeConversation"))) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    meter.touch();
    await meter.quiet(quietMs(target));
    return { wallMs: meter.lastActivity - start };
  });
  if (!reader) throw new Error("unreachable");
  for (const kind of ["plain", "tools", "approval"] as const) {
    if (wants(`turn.${kind}`)) await turn(target, session, reader, kind, samples, rep);
  }
  await reader.stop();
  await runtime.close();
  runtime = newRuntime(target);
  instance = runtime.get(agent, name);
  await measure(target, "open.again", samples, rep, () => instance.open());
  await runtime.close();
}

/**
 * `CONCURRENT` instances, each with a reader attached to a session, all submitting a plain turn at once: what a busy
 * server's pool sees. Reports the median over the turns of each metric.
 */
async function concurrentTurns(target: Target, samples: Sample[], rep: number) {
  const runtime = newRuntime(target);
  try {
    const sessions: { session: AgentSession; reader: Reader }[] = [];
    for (let i = 0; i < CONCURRENT; i++) {
      const instance = runtime.get(agent, `${target.prefix}-c${rep}-${i}`);
      const session = instance.session((await instance.createSession()).id);
      sessions.push({ session, reader: new Reader(session) });
    }
    await meter.quiet(quietMs(target) + 200);
    paced.setResponses(Array.from({ length: CONCURRENT }, () => answer(ANSWER_TOKENS)));
    await measure(target, `turn.concurrent${CONCURRENT}`, samples, rep, async () => {
      const start = performance.now();
      const results = await Promise.all(
        sessions.map(async ({ session, reader }) => {
          await session.submit({ text: "concurrent", requestId: crypto.randomUUID() });
          const submitted = performance.now();
          const first = await reader.waitFor(0, (event) => event.type === "assistant:delta");
          const end = await reader.waitFor(0, (event) => event.type === "run:end");
          const { gaps } = deltaTimings(reader.arrivals, 0, paced.emissions);
          return {
            submitMs: submitted - start,
            firstDeltaMs: first.at - start,
            runEndMs: end.at - start,
            gapP95Ms: quantile(gaps, 0.95),
          };
        }),
      );
      const of = (key: keyof (typeof results)[number]) => results.map((result) => result[key]);
      return {
        submitMs: median(of("submitMs")),
        firstDeltaMs: median(of("firstDeltaMs")),
        firstDeltaMaxMs: Math.max(...of("firstDeltaMs")),
        runEndMs: median(of("runEndMs")),
        runEndMaxMs: Math.max(...of("runEndMs")),
        gapP95Ms: median(of("gapP95Ms")),
      };
    });
    for (const { reader } of sessions) await reader.stop();
  } finally {
    await runtime.close();
  }
}

/** Fixtures for the read scenarios: one scope with many sessions, one session with a long history. */
async function buildFixtures(target: Target) {
  const runtime = newRuntime(target);
  try {
    const many = runtime.get(agent, `${target.fixturePrefix}-many`);
    const existing = await many.listSessions();
    for (let i = existing.length; i < SESSIONS; i++) await many.createSession({ model: fast.model });
    const history = runtime.get(agent, `${target.fixturePrefix}-history`);
    const sessions = await history.listSessions();
    const id = sessions[0]?.id ?? (await history.createSession({ model: fast.model })).id;
    const session = history.session(id);
    const reader = new Reader(session);
    // The turns it holds already (another target built them): what a full read reaches once it settles.
    await meter.quiet(100);
    const ends = reader.arrivals.filter((arrival) => arrival.item.event.type === "run:end").length;
    for (let turnIndex = ends; turnIndex < HISTORY_TURNS; turnIndex++) {
      fast.setResponses([answer(30)]);
      const from = reader.arrivals.length;
      await session.submit({ text: `history ${turnIndex}`, requestId: `h${turnIndex}` });
      await reader.waitFor(from, (event) => event.type === "run:end");
    }
    await reader.stop();
  } finally {
    await runtime.close();
  }
}

async function readScenarios(target: Target, samples: Sample[], rep: number) {
  if (wants("listSessions")) {
    const runtime = newRuntime(target);
    const instance = runtime.get(agent, `${target.fixturePrefix}-many`);
    await instance.open();
    await measure(target, `listSessions.${SESSIONS}`, samples, rep, async () => {
      const list = await instance.listSessions();
      if (list.length !== SESSIONS) throw new Error(`listed ${list.length}`);
    });
    // Again on the same instance: pi-durable keeps loaded documents in memory (`documentRetentionMs`).
    await measure(target, `listSessions.${SESSIONS}.again`, samples, rep, async () => {
      await instance.listSessions();
    });
    await runtime.close();
  }
  if (wants("events.history")) {
    // From the start: a client opening a long session for the first time.
    let runtime = newRuntime(target);
    let instance = runtime.get(agent, `${target.fixturePrefix}-history`);
    await instance.open();
    const [info] = await instance.listSessions();
    if (!info) throw new Error("no history session");
    let session = instance.session(info.id);
    let cursor = "";
    await measure(target, `events.historyFromStart`, samples, rep, async () => {
      const start = performance.now();
      const reader = new Reader(session);
      const first = await reader.waitFor(0, () => true);
      let seen = 0;
      const end = await reader.waitFor(0, (event) => event.type === "run:end" && ++seen === HISTORY_TURNS);
      const runEnds = reader.arrivals.filter((arrival) => arrival.item.event.type === "run:end");
      cursor = (runEnds.at(-2) as { item: { cursor: string } }).item.cursor;
      const events = reader.arrivals.length;
      await reader.stop();
      return { firstEventMs: first.at - start, lastEventMs: end.at - start, events };
    });
    await runtime.close();
    // From a recent cursor, in a runtime that never handed it out: a client reconnecting to another process (or after a
    // restart), one turn behind.
    runtime = newRuntime(target);
    instance = runtime.get(agent, `${target.fixturePrefix}-history`);
    await instance.open();
    session = instance.session(info.id);
    await measure(target, `events.historyFromCursor`, samples, rep, async () => {
      const start = performance.now();
      const reader = new Reader(session, cursor);
      const end = await reader.waitFor(0, (event) => event.type === "run:end");
      const events = reader.arrivals.length;
      await reader.stop();
      return { lastEventMs: end.at - start, events };
    });
    await runtime.close();
  }
}

/** Idle instances' lease traffic: statements per second with nothing else going on. */
async function idleLeases(pool: pg.Pool, prefix: string, samples: Sample[]) {
  const store = createPostgresStore(meter.pool(pool), { ttlMs: 3_000 });
  const runtime = createAgentRuntime({
    agents: [agent],
    host: nodeHost(store),
    models,
    ports: {},
    defaultModel: paced.model,
  });
  const instances = 20;
  for (let i = 0; i < instances; i++) await runtime.get(agent, `${prefix}-idle${i}`).open();
  const window = meter.open();
  const seconds = 6;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const records = window.close();
  const renewals = records.statements.filter((statement) => statement.kind === "lease.renew").length;
  const other = records.statements.length - renewals;
  samples.push({
    target: "postgres",
    scenario: "lease.idle20",
    rep: 0,
    wallMs: seconds * 1000,
    ...counts(records),
    metrics: {
      instances,
      ttlMs: 3_000,
      renewIntervalMs: 1_000,
      renewalsPerSecond: renewals / seconds,
      otherStatements: other,
    },
  });
  await runtime.close();
}

async function selectOne(pool: pg.Pool, n: number): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await pool.query("SELECT 1");
    times.push(performance.now() - start);
  }
  return times;
}

const poolOptions = (url: string): pg.PoolConfig => ({ connectionString: url, max: POOL_MAX, idleTimeoutMillis: 0 });

/** Fills `pool` to its size with connections, so steady-state numbers carry no connection setup. */
async function warm(pool: pg.Pool) {
  await Promise.all(Array.from({ length: POOL_MAX }, () => pool.query("SELECT pg_sleep(0.02)")));
}

async function main() {
  const startedAt = new Date();
  const samples: Sample[] = [];
  const calibration: Results["calibration"] = [];
  const machine = {
    cpu: cpus()[0]?.model ?? "?",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()}`,
    node: process.version,
    postgres: undefined as string | undefined,
  };
  const config = {
    rtts: RTTS,
    reps: REPS,
    tokensPerSecond: TPS,
    poolMax: POOL_MAX,
    progress: PROGRESS,
    answerTokens: ANSWER_TOKENS,
    sessions: SESSIONS,
    historyTurns: HISTORY_TURNS,
    concurrent: CONCURRENT,
  };
  console.error(`bench: ${JSON.stringify(config)}`);

  const targets: { target: Target; setup?: () => Promise<void> }[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  try {
    if (BACKENDS.has("memory")) {
      const storages = new Map<string, Storage>();
      const host = nodeHost({
        lease: inProcessLeases(),
        storage: async (scope) => {
          const key = `${scope.kind}/${scope.name}`;
          let storage = storages.get(key);
          if (!storage) {
            storage = meter.storage(new MemoryStorage(), { keepOpen: true });
            storages.set(key, storage);
          }
          return storage;
        },
      });
      targets.push({
        target: { label: "memory", backend: "memory", rttMs: undefined, host, prefix: "m", fixturePrefix: "m" },
      });
    }
    if (BACKENDS.has("sqlite")) {
      const directory = await mkdtemp(join(tmpdir(), "agent-runtime-bench-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const open = sqliteStorage({ directory });
      const host = nodeHost({
        lease: inProcessLeases(),
        storage: async (scope, lease) => meter.storage(await open(scope, lease)),
      });
      targets.push({
        target: { label: "sqlite", backend: "sqlite", rttMs: undefined, host, prefix: "q", fixturePrefix: "q" },
      });
    }
    if (DATABASE_URL !== undefined && (BACKENDS.has("postgres") || BACKENDS.has("direct"))) {
      const admin = new pg.Client({ connectionString: DATABASE_URL });
      await admin.connect();
      const name = `agent_runtime_bench_${Date.now().toString(36)}`;
      machine.postgres = (await admin.query<{ version: string }>("SELECT version()")).rows[0]?.version;
      await admin.query(`CREATE DATABASE "${name}"`);
      await admin.end();
      cleanups.push(async () => {
        const client = new pg.Client({ connectionString: DATABASE_URL });
        await client.connect();
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await client.end();
      });
      const url = new URL(DATABASE_URL);
      url.pathname = `/${name}`;
      const directUrl = url.toString();
      const migrator = new pg.Pool({ connectionString: directUrl, max: 1 });
      await migrate(migrator);
      await migrator.end();

      const direct = new pg.Pool(poolOptions(directUrl));
      direct.on("error", () => undefined);
      cleanups.push(() => direct.end());
      const proxy = new DelayProxy(url.hostname, Number(url.port || 5432));
      cleanups.push(() => proxy.close());
      const proxied = new URL(directUrl);
      proxied.hostname = "127.0.0.1";
      proxied.port = String(await proxy.port);
      const proxiedUrl = proxied.toString();
      const pool = new pg.Pool(poolOptions(proxiedUrl));
      pool.on("error", () => undefined);
      cleanups.push(() => pool.end());

      // Calibration: the proxy's own overhead, and what one statement and one new connection cost at each RTT.
      await warm(direct);
      await proxy.setRtt(0);
      await warm(pool);
      calibration.push({ path: "direct", rttMs: 0, selectOneMs: await selectOne(direct, 300), connectMs: [] });
      for (const rtt of RTTS) {
        await proxy.setRtt(rtt);
        const connectMs: number[] = [];
        for (let i = 0; i < 5; i++) {
          const cold = new pg.Pool({ connectionString: proxiedUrl, max: 1 });
          const start = performance.now();
          await cold.query("SELECT 1");
          connectMs.push(performance.now() - start);
          await cold.end();
        }
        calibration.push({
          path: "proxy",
          rttMs: rtt,
          selectOneMs: await selectOne(pool, rtt >= 20 ? 40 : 200),
          connectMs,
        });
      }
      await proxy.setRtt(0);

      const store = createPostgresStore(meter.pool(direct));
      const proxiedStore = createPostgresStore(meter.pool(pool));
      // The store's host, with its storage metered. The runtime hands `storage` the lease the store's `lease()` made.
      const hostOf = (s: typeof store): AgentHost =>
        nodeHost({ ...s, storage: async (scope, lease) => meter.storage(await s.storage(scope, lease)) });
      if (BACKENDS.has("direct")) {
        targets.push({
          target: {
            label: "postgres direct",
            backend: "postgres",
            rttMs: 0,
            host: hostOf(store),
            prefix: "pd",
            fixturePrefix: "pd",
          },
        });
      }
      if (BACKENDS.has("postgres")) {
        let fixturesBuilt = false;
        const host = hostOf(proxiedStore);
        for (const rtt of RTTS) {
          const target: Target = {
            label: `postgres ${rtt}ms`,
            backend: "postgres",
            rttMs: rtt,
            host,
            prefix: `p${rtt}`,
            fixturePrefix: "p",
          };
          targets.push({
            target,
            setup: async () => {
              if (!fixturesBuilt) {
                await proxy.setRtt(0);
                await buildFixtures(target);
                fixturesBuilt = true;
              }
              await proxy.setRtt(rtt);
            },
          });
        }
        if (wants("lease")) {
          targets.push({
            target: { label: "lease", backend: "postgres", rttMs: 10, host, prefix: "l", fixturePrefix: "l" },
            setup: async () => {
              await proxy.setRtt(10);
              await idleLeases(pool, "lease", samples);
            },
          });
        }
      }
    }

    for (const { target, setup } of targets) {
      const started = performance.now();
      await setup?.();
      if (target.label === "lease") continue;
      if (target.backend !== "postgres" || target.label === "postgres direct") await buildFixtures(target);
      for (let rep = -1; rep < REPS; rep++) {
        if (wants("open") || wants("createSession") || wants("events.attach") || wants("turn")) {
          await sessionScenarios(target, samples, rep);
        }
        await readScenarios(target, samples, rep);
        if (CONCURRENT > 0 && wants("turn.concurrent")) await concurrentTurns(target, samples, rep);
      }
      console.error(`bench: ${target.label} done in ${((performance.now() - started) / 1000).toFixed(0)} s`);
    }
  } finally {
    for (const cleanup of cleanups.reverse())
      await cleanup().catch((error: unknown) => console.error("cleanup failed", error));
  }

  const results: Results = { startedAt: startedAt.toISOString(), machine, config, calibration, samples };
  const out =
    env.BENCH_OUT ?? join(import.meta.dirname, "results", `${startedAt.toISOString().replaceAll(":", "-")}.json`);
  await mkdir(join(out, ".."), { recursive: true });
  await writeFile(out, JSON.stringify(results, null, 1));
  console.error(`bench: results in ${out}`);
  printReport(results);
}

await main();
