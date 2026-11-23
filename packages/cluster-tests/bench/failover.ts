// What a cluster's forwarding costs, measured on two nodes in this process: how long an instance whose home crashed
// stays unavailable (its failover), and what one more hop adds to a call.
//
//   pnpm bench                      # PGlite
//   TEST_DATABASE_URL=... pnpm bench  # and Postgres
//
// Failover: B, the home, crashes (its database statements fail from then on, unsent, and its server closes), and A
// polls a call every `POLL_MS` until it is answered. The lease that B renewed last expires `ttlMs` after that renewal,
// so the failover from the crash is `ttlMs` minus how long before the crash B last renewed (up to `ttlMs / 3`), plus
// one poll. "From renewal" measures from B's last statement instead, which should be `ttlMs` plus one poll.
//
// The hop: one call answered by the home directly, and the same call through a peer, which first asks the database for
// the lease (refused, in two statements) and then forwards the call on a connection of its own.

import { call } from "../test/http.ts";
import { agent, cluster, pgliteDatabase, postgresDatabase, uniqueName } from "../test/nodes.ts";
import type { Database } from "../test/nodes.ts";

const RUNS = 10;
const TTLS = [1_000, 3_000];
const POLL_MS = 5;
const CALLS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function summary(values: readonly number[], digits = 0): string {
  const sorted = [...values].sort((x, y) => x - y);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(digits);
  return `min ${at(0)}  median ${at(0.5)}  p90 ${at(0.9)}  max ${at(1)}`;
}

async function failover(database: Database, ttlMs: number) {
  const nodes = cluster(database);
  try {
    const a = await nodes.start({ ttlMs });
    const b = await nodes.start({ ttlMs });
    const user = uniqueName("alice");
    await b.runtime.get(agent, user).createSession();
    const as = { authorization: `Bearer ${user}` };
    // A random point in B's renewal interval, as a crash would fall.
    await sleep(ttlMs * Math.random());
    await b.crash();
    const crashedAt = performance.now();
    let refusals = 0;
    while ((await call(a.url, "listSessions", {}, as)).status !== 200) {
      refusals += 1;
      await sleep(POLL_MS);
    }
    const servedAt = performance.now();
    // Read now, not at the crash: a renewal in flight then still lands, and extends the lease.
    return { fromCrash: servedAt - crashedAt, fromRenewal: servedAt - b.lastStatementAt(), refusals };
  } finally {
    await nodes.close();
  }
}

async function hop(database: Database) {
  const nodes = cluster(database);
  try {
    const a = await nodes.start();
    const b = await nodes.start();
    const user = uniqueName("alice");
    await b.runtime.get(agent, user).createSession();
    const as = { authorization: `Bearer ${user}` };
    const timed = async (base: string) => {
      const times: number[] = [];
      for (let index = 0; index < CALLS; index += 1) {
        const started = performance.now();
        const { status } = await call(base, "listSessions", {}, as);
        if (status !== 200) throw new Error(`listSessions answered ${status}`);
        times.push(performance.now() - started);
      }
      return times;
    };
    // Warm both paths first, then measure each.
    await timed(b.url);
    await timed(a.url);
    const statement: number[] = [];
    for (let index = 0; index < CALLS; index += 1) {
      const started = performance.now();
      await database.lease({ kind: agent.kind, name: user });
      statement.push(performance.now() - started);
    }
    return { direct: await timed(b.url), forwarded: await timed(a.url), statement };
  } finally {
    await nodes.close();
  }
}

const url = process.env.TEST_DATABASE_URL;
const databases: [string, () => Promise<Database>][] = [
  ["PGlite", pgliteDatabase],
  ...(url === undefined ? [] : [["Postgres", () => postgresDatabase(url)] as [string, () => Promise<Database>]]),
];

for (const [name, open] of databases) {
  const database = await open();
  try {
    for (const ttlMs of TTLS) {
      const runs = [];
      for (let run = 0; run < RUNS; run += 1) runs.push(await failover(database, ttlMs));
      console.log(`${name}, ttlMs ${ttlMs}, renewIntervalMs ${Math.floor(ttlMs / 3)}, ${RUNS} crashes:`);
      console.log(`  failover from the crash, ms:        ${summary(runs.map((run) => run.fromCrash))}`);
      console.log(`  failover from B's last renewal, ms: ${summary(runs.map((run) => run.fromRenewal))}`);
      console.log(`  503s answered meanwhile:            ${summary(runs.map((run) => run.refusals))}`);
    }
    const { direct, forwarded, statement } = await hop(database);
    console.log(`${name}, listSessions, ${CALLS} calls each, ms:`);
    console.log(`  to the home:         ${summary(direct, 2)}`);
    console.log(`  through a peer:      ${summary(forwarded, 2)}`);
    // The peer's own part of a forward: its lease attempt, refused, is two statements (one names the holder).
    console.log(`  one statement alone: ${summary(statement, 2)}`);
  } finally {
    await database.close();
  }
}
