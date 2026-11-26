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
    await sleep(ttlMs * Math.random());
    await b.crash();
    const crashedAt = performance.now();
    let refusals = 0;
    while ((await call(a.url, "listSessions", {}, as)).status !== 200) {
      refusals += 1;
      await sleep(POLL_MS);
    }
    const servedAt = performance.now();
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
    console.log(`  one statement alone: ${summary(statement, 2)}`);
  } finally {
    await database.close();
  }
}
