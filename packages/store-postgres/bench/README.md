# Motoko on a remote Postgres

What a turn costs when the database is a network hop away, where the time goes, and what to set. The
benchmark drives the runtime's public API (`createAgentRuntime` over `nodeHost`) on MemoryStorage, SQLite and
Postgres, the last through a proxy that delays every byte by a set time each way. The model is pi-ai's
faux provider, streaming at a set rate: no keys, no network.

## Running it

```bash
pnpm install
# Any Postgres you may create a database on; the benchmark creates one of its own and drops it.
BENCH_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm --filter @chia1104/motoko-store-postgres bench
```

Without the URL only MemoryStorage and SQLite run. A run of the defaults takes about 15 minutes and
prints the tables below (Markdown) and writes every sample as JSON to `bench/results/`. Options are
environment variables:

| variable             | default                          | what                                                                                                                                                     |
| -------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BENCH_DATABASE_URL` | none                             | A Postgres URL, of any database. The benchmark creates a database of its own and drops it. Without it, only MemoryStorage and SQLite run.                |
| `BENCH_RTTS`         | `0,2,10,40`                      | The round trips to simulate, in ms.                                                                                                                      |
| `BENCH_REPS`         | 7                                | Measured repetitions per scenario. One more unmeasured warm-up runs first.                                                                               |
| `BENCH_BACKENDS`     | `memory,sqlite,direct,postgres`  | The backends to run. `direct` is Postgres without the proxy.                                                                                             |
| `BENCH_TPS`          | 100                              | Tokens per second the model streams at.                                                                                                                  |
| `BENCH_PROGRESS`     | pi-durable's                     | pi-durable `settings.progress` for the runtime, such as `partialIntervalMs=500,persistWithinMs=1000`, passed through `createAgentRuntime({ settings })`. |
| `BENCH_POOL_MAX`     | 10, pg's default                 | The pg pool's size.                                                                                                                                      |
| `BENCH_OUT`          | `bench/results/<timestamp>.json` | Where to write the JSON results.                                                                                                                         |
| `BENCH_ONLY`         | all scenarios                    | Comma-separated scenario prefixes to run.                                                                                                                |
| `BENCH_CONCURRENT`   | 0, not run                       | Also run that many instances streaming a turn at once.                                                                                                   |

`node --conditions=@chia1104/motoko-source bench/report.ts a.json [b.json]` prints a saved run again, or
compares two.

A throwaway local cluster, as these numbers were taken:

```bash
export LC_ALL=C PG=/opt/homebrew/opt/postgresql@18/bin
$PG/initdb --locale=C -E UTF8 -U postgres -A trust -D ./.pgbench/data
$PG/pg_ctl -D ./.pgbench/data -l ./.pgbench/log -w start \
  -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c max_connections=200"
BENCH_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres pnpm --filter @chia1104/motoko-store-postgres bench
$PG/pg_ctl -D ./.pgbench/data stop && rm -rf ./.pgbench
```

The benchmark runs the TypeScript sources with Node's type stripping (`node --conditions=@chia1104/motoko-source`),
so it needs no build.

## Method

- **The network.** `proxy.ts` is a TCP proxy (built like the tests' `FreezableProxy`) in a worker
  thread of its own, so its timers neither wait for nor delay the runtime's event loop. Each chunk of bytes
  is forwarded `RTT / 2` after it arrived, in order, either way; a new connection's first byte also
  waits one RTT (the TCP handshake). Calibration, every run:

  | path   | configured RTT | `SELECT 1` p50 (p10–p90) | new connection + `SELECT 1` p50 |
  | ------ | -------------- | ------------------------ | ------------------------------- |
  | direct | 0              | 0.07 (0.07–0.09) ms      | –                               |
  | proxy  | 0              | 0.13 (0.10–0.19) ms      | 2.8 ms                          |
  | proxy  | 2 ms           | 2.22 (2.15–2.27) ms      | 8.0 ms                          |
  | proxy  | 10 ms          | 10.3 (10.3–10.4) ms      | 31.7 ms                         |
  | proxy  | 40 ms          | 40.5 (40.4–41.6) ms      | 127 ms                          |

  The proxy adds 0.06 ms at zero delay, and a statement costs the configured round trip plus 1 to 11 %.
  A new connection costs about 3 RTT plus 2 to 3 ms of backend start (TCP handshake, startup exchange
  with trust auth, the query). There is no TLS here: on a real network TLS adds about 2 RTT more and
  SCRAM password auth about 2 more (inferred from the protocols, not measured), so expect about 7 RTT
  (280 ms at 40 ms) per new connection. The pool is filled and kept (`idleTimeoutMillis: 0`) before
  anything is measured, so the scenario numbers carry no connection setup; it is reported here only.

- **Counting.** `meter.ts` wraps the `pg` pool (each `query()` is one statement, one round trip) and
  every pi-durable `Storage` (so MemoryStorage and SQLite are counted too). A statement is attributed to
  the Storage call it ran in, and that call to its caller: the runtime frame on its async stack, else the
  runtime call into the Harness it runs under, else the pi-durable frame. Commits run on pi-durable's commit
  line, whose pump keeps the async context of whoever started it, so commits are named by what they
  write (`entry pi.user`, `task pi.generation:running`, `doc pi.live`, ...).
- **Scenarios.** Each is measured 7 times after one unmeasured warm-up, on its own fresh scope; tables
  give the median and the range (min–max). A turn is measured with a reader attached to the session, as
  a browser holding an SSE connection: from the `submit()` call to `run:end` reaching that reader.
  Answers are 300 tokens (100 after a tool round), streamed at 100 tokens/s one token per chunk. The
  history scenarios read a session of 150 turns (600 events). The lease scenario holds 20 idle
  instances for 6 s with a 3 s TTL (renewal every 1 s).
- **Machine.** Apple M3 Pro (12 cores, 18 GB), macOS 27.3, Node 26.13.1, PostgreSQL 18.6 (Homebrew)
  on the same machine, pg pool of 10 unless stated.

What the proxy does not capture: jitter and its tail (a real p99 is worse than a fixed delay), packet
loss and retransmits, bandwidth limits (large catch-up pages cost more than their round trips here),
TLS handshakes and auth exchanges, a pooler such as PgBouncer in transaction mode (one more hop and its
own queueing), a loaded server (lock waits, I/O, autovacuum), and real data volumes behind the indexes:
every table here is small and hot in cache.

## Results

With this package's fixes S1–S3 and the core patches C1–C3 below applied (C2 and C3 change
`listSessions` and the two `events()` attaches; without them those rows are as in the fix tables);
median (min–max) in ms over 7 repetitions; statements are per operation and do not depend on the RTT.

| operation                                             | statements (before → after) | memory | sqlite | pg 0 ms          | pg 2 ms          | pg 10 ms         | pg 40 ms         |
| ----------------------------------------------------- | --------------------------- | ------ | ------ | ---------------- | ---------------- | ---------------- | ---------------- |
| open an instance, new scope                           | 13 → 10                     | 1.2    | 4.6    | 8.1 (5.2–11.2)   | 28.0 (24.8–29.7) | 106 (105–111)    | 424 (417–427)    |
| open it again (has history)                           | 13 → 10                     | 2.2    | 4.1    | 9.9 (5.7–13.1)   | 32.7 (31.1–34.4) | 113 (108–117)    | 421 (417–424)    |
| `createSession`                                       | 8 → 8                       | 2.1    | 2.6    | 13.5 (6.7–17.3)  | 25.1 (23.8–26.2) | 87.3 (86.8–90.4) | 348 (337–352)    |
| `events()` on a new session                           | 4 → 3                       | 1.9    | 1.6    | 6.0 (2.3–9.8)    | 6.7 (6.2–8.2)    | 22.4 (22.1–22.8) | 86.7 (83.6–88.7) |
| plain turn (300 tokens)                               | 16 → 16                     | 3295   | 3303   | 3323 (3293–3364) | 3332 (3320–3347) | 3405 (3401–3410) | 3730 (3711–3737) |
| turn with 3 tool calls, then 100 tokens               | 33 → 33                     | 1242   | 1260   | 1287 (1268–1296) | 1337 (1329–1346) | 1590 (1579–1609) | 2576 (2558–2634) |
| turn parked on an approval, approved                  | 34 → 34                     | 1178   | 1188   | 1208 (1198–1229) | 1272 (1256–1286) | 1532 (1518–1557) | 2556 (2538–2560) |
| `listSessions`, 50 sessions, first call               | 101 → 51                    | 5.9    | 13.8   | 15.6 (9.1–22.2)  | 21.5 (19.8–22.9) | 68.8 (66.2–70.6) | 265 (250–270)    |
| `listSessions` again, same instance                   | 1                           | 0.9    | 1.1    | 1.5 (1.2–3.0)    | 3.6 (3.0–4.0)    | 11.6 (11.0–13.1) | 43.1 (42.1–49.7) |
| `events()` from the start, 150 turns                  | 17 → 11                     | 6.9    | 11.4   | 23.1 (13.6–26.7) | 33.5 (31.5–39.8) | 114 (111–118)    | 441 (432–446)    |
| `events()` from a cursor one turn back, other runtime | 17 → 11                     | 3.2    | 4.8    | 9.2 (6.7–14.9)   | 27.6 (25.9–32.1) | 110 (107–115)    | 427 (422–435)    |

What a user feels in the plain turn: when `submit()` resolves, when the model is called, when the
first streamed delta reaches the reader, the gaps between deltas, and how far each delta trails the
model producing it (lag):

| target   | `submit()`    | model called  | first delta   | gap p50 | gap p95 | gap max | lag p95 | lag max | `run:end` |
| -------- | ------------- | ------------- | ------------- | ------- | ------- | ------- | ------- | ------- | --------- |
| memory   | 2.1           | 4.6           | 106           | 110     | 112     | 112     | 5.6     | 11.1    | 3295      |
| sqlite   | 3.5           | 7.5           | 109           | 110     | 112     | 112     | 5.8     | 8.2     | 3303      |
| pg 0 ms  | 10.0          | 19.2          | 121           | 110     | 112     | 113     | 11.3    | 12.1    | 3323      |
| pg 2 ms  | 11.9          | 26.9          | 128           | 110     | 112     | 112     | 5.7     | 11.9    | 3332      |
| pg 10 ms | 34.7          | 89.4          | 190           | 110     | 112     | 112     | 5.5     | 11.9    | 3404      |
| pg 40 ms | 129 (126–132) | 340 (336–351) | 441 (436–453) | 110     | 112     | 112     | 5.4     | 6.1     | 3730      |

The 100 ms between deltas is pi-durable's `partialIntervalMs`: the faux model produces a token every
10 ms, and pi-durable commits the partial answer to memory at most every 100 ms.

Tool calls and approvals:

| target   | tool round (3 calls) | approval request reaches reader | `approve()` resolves | approve → tool result |
| -------- | -------------------- | ------------------------------- | -------------------- | --------------------- |
| memory   | 141                  | 73                              | 1.0                  | 2.7                   |
| pg 0 ms  | 166                  | 94                              | 4.1                  | 9.8                   |
| pg 2 ms  | 204                  | 117                             | 9.5                  | 27.2                  |
| pg 10 ms | 381                  | 221                             | 34.2                 | 99.3                  |
| pg 40 ms | 1090 (1083–1152)     | 632 (624–642)                   | 131 (127–134)        | 387 (380–399)         |

Many instances at once (20 instances each streaming a plain turn together, pg 40 ms, 5 repetitions):

| pool size | `submit()` p50 | first delta p50 | first delta, slowest | `run:end` p50 | gap p95 |
| --------- | -------------- | --------------- | -------------------- | ------------- | ------- |
| 2         | 1084           | 3296            | 3482                 | 6734          | 148     |
| 5         | 445            | 1382            | 1445                 | 4780          | 157     |
| 10        | 238            | 754             | 776                  | 4175          | 152     |
| 20        | 140            | 446             | 448                  | 3725          | 114     |
| 40        | 139            | 446             | 448                  | 3699          | 121     |

Idle leases (20 instances, renewal every 1 s): 20 statements/s before, 1 statement/s after.

## Conclusions

**Is it usable on a remote database?** Within a region (1 to 5 ms), yes: at 2 ms a plain turn costs
37 ms more than in memory, the first token reaches the browser at 128 ms instead of 106, and a tool
round costs 63 ms more. At 10 ms it is still fine (first token 190 ms, a tool round +240 ms). At 40 ms
(across regions) streaming itself still feels live: deltas arrive every 110 ms, trailing the model by
at most 6 to 16 ms, exactly as on MemoryStorage. Everything around the stream is slow, though: the first
token comes 441 ms after `submit()` instead of 106, each tool round costs about 950 ms more (1090 vs 141),
an approval request shows 632 ms after the input, and opening an instance or catching up a long session
takes 420 to 440 ms. A chat agent works across regions; a tool-heavy agent loses about a second per tool
round, so an agent making five rounds a turn waits about five seconds more (inferred from the per-round
number). Keep the database in the app's region.

**Where the time goes.** Every statement waits for the one before it: at most one statement per
instance was ever in flight (the "max in flight" of every scenario was 2, one Storage call and its
statement), so wall time is statements × RTT. `(time at 40 ms − time at 0 ms) / 40` gives 10 round
trips for a plain turn, 32 for a tool turn, 34 for an approval turn, 10 for an open, 10.5 for a catch-up.
pi-durable serializes every read and commit admission on its line. Reads inside one transaction are the
exception: pi-durable runs them concurrently, which patch C2 uses.

Inherent to pi-durable's contract (it commits before it shows), unchanged here:

- A turn's commits. A plain turn is 7 commits and 2 reads. Before the model is called: the admission's
  duplicate check (`submissionByRequest`), the user entry with its submission and generation task, the
  generation going `running`, the context read, and in a session's first turn the system prompt entry.
  That is 8 round trips, 340 ms at 40 ms. After the answer comes the commit that stores it (2 round
  trips between the last token and `run:end`).
- Tool rounds: about 16 commits for three calls. pi-durable sends one storage commit at a time; of
  the three tool tasks' `running` commits it grouped two into one call, in every run, and nothing else.
- The open: pi-durable's recovery scans (`scanTasks` ×5, `scanSubmissions` ×1) are 6 of its 10
  statements. The runtime's `harness.inspect()` (to find the sessions with unfinished work) adds 2
  `scanSubmissions`, and the lease and the storage open 1 each.
- Each commit is two statements, because this storage's commit is one read plus one guarded write. That
  is a deliberate choice kept here (it keeps Durable's checks in TypeScript, ported unchanged). Folding
  the checks into the write statement would make a commit one round trip and take about 5 round trips
  off a plain turn's path to its first token. That is inferred, not measured, and outside what was
  changed.

Deferred commits behave as pi-durable says. Partial answers reach the reader without waiting for
storage: gaps and lag are the same on MemoryStorage and at 40 ms. The deferred `pi.live` flushes (3 per
3.3 s answer, 6 statements) run beside the stream. Nothing in the runtime or the storage holds a delta back.
There is one exception: when the pool is too small, gap p95 rises from 112 to about 155 ms (the
20-instance table). The inferred cause is a partial commit waiting at the gate of a `pi.live` flush that
is itself queued for a connection.

The runtime's and the storage's own round trips, and what became of them:

- _Schema check and scope lookup on every lease and open_ (storage): 5 statements before the Harness
  opened. Now 2, with the check inside them (fix S1).
- _Looking the conversation up and reading its record before every `submit`/`approve`/`abort`/`events`_
  (runtime): free. pi-durable's `CachedStorage` answers both from memory; only the first access after an open
  costs one statement (`conversation`).
- _`listSessions` reading one document per session_ (runtime): 2 statements per session, one after another
  (4.2 s for 50 sessions at 40 ms). Now one statement per session, run concurrently (fix S3, patch C2): 265 ms.
- _What the watch reads when a reader attaches_: pi-durable's view (5 documents, 2 statements each before
  S3, 1 after, and one entry window). Then the runtime's own reads: the approvals document (absent in a session
  without approvals, so it was read twice per attach, now once: S3), the run endings (`scanSubmissions`),
  and the history pages. The runtime read the approvals document and the run endings one after the other
  (now together: C3).
- _Lease renewals_ (storage): one statement per lease per 10 s, so 1000 idle instances meant 100
  statements/s holding about 4 connections busy at 40 ms (inferred). Now one statement per store per
  interval, whatever the number of leases (S2). The runtime never closes an idle instance by itself: each
  instance a server ever served keeps its Harness, its memory and its lease until `runtime.close()`.

What did not help:

- `settings.progress` with `partialIntervalMs: 500, outputIntervalMs: 500` (pi-durable's example for a
  remote storage) saves nothing here: partial answers are deferred commits that the storage receives
  only when flushed, so a plain turn stays at 16 statements. It makes streaming worse: the first delta
  comes at 855 ms instead of 448 at 40 ms, gaps grow from 110 to 585 ms, and lag p95 from 6 to 90 ms.
- `persistWithinMs: 5000` takes a plain turn from 16 statements to 10 (the three `pi.live` flushes go)
  and changes no latency (first delta 452 vs 448 ms, `run:end` 3741 vs 3726 ms at 40 ms). It cuts write
  load, at the price of losing up to 5 s of a partial answer in a crash.
- `createSession` is 9 to 10 ms slower at 40 ms after the fixes (338 → 348 ms), in two separate runs,
  with the same 8 statements. The new `findDocument` statement costs 0.1 ms more per miss on the server
  (measured directly), which does not explain it. Cause not found; it is 3 %.

## Fixes in this package

Each fix keeps the guarantees: pi-durable's storage conformance suite passes unmodified on PGlite and on
Postgres, a commit is still one read plus one guarded write, fencing by lease token and expiry stays in
the write statement, and every lease and storage open still checks the schema version.

| fix | what                                                                                                                                                                                                                                                                                                                                                                                                                                          | before → after (statements; ms at 40 ms)                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | The lease is acquired by one upsert of the scope row that takes the lease only if it is free or expired, written only if the migrations journal matches (the version check moves into the statement). The storage opens with one statement reading the journal and the scope's counters. A held lease costs one more statement, to name its holder. A missing journal falls back to the separate check, for the precise `SchemaVersionError`. | open 13 → 10; 539 → 422 ms (10 ms: 138 → 107)                                                                                                         |
| S2  | A store renews all its leases in one statement per `renewIntervalMs`. Each lease keeps its own deadline, armed from the send time of the renewal that confirmed it, and learns from the same statement whether it was taken, expired or deleted.                                                                                                                                                                                              | 20 idle leases: 20 → 1 statement/s                                                                                                                    |
| S3  | `findDocument` reads the document's content in the same statement. The `document()` call pi-durable makes right after it is served from that, once, if no commit started or ended in between and the lease is held. A current address found empty is remembered until the next commit (only this storage, the scope's single writer, can create a document there).                                                                            | document load 2 → 1. `listSessions` 101 → 51 statements, 4208 → 2200 ms. History attach 17 → 11, 725 → 486 ms. New session attach 4 → 3, 168 → 130 ms |

Turns did not change (16, 33 and 34 statements; within ±1 % in time). New tests in
`test/round-trips.test.ts` pin the counts and the cache invalidation; three of the four fail on the code
before the fixes.

## Changes made in `@chia1104/motoko-core`

Changes in `@chia1104/motoko-core` that came out of these measurements; all three are applied.

| patch | what                                                                                                                                                                                                                                | effect                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| C1    | `createAgentRuntime({ settings })`: pi-durable's `HarnessOptions.settings`, passed to every Harness. Without it a host cannot set `settings.progress` (or anything else in `settings`) at all.                                      | No change by itself; it enables `persistWithinMs` (16 → 10 statements per 300-token turn) |
| C2    | `listSessions` loads every session's document inside one transaction, where pi-durable runs the loads concurrently, and throws its result out, so the transaction writes nothing. A missing document still reads as `createdAt: 0`. | 50 sessions, after S3: 2200 → 265 ms at 40 ms (68.8 ms at 10 ms)                          |
| C3    | The watch's catch-up reads the approvals document and the run endings at once instead of one after the other.                                                                                                                       | New session attach 130 → 87 ms; history attach 486 → 441 ms at 40 ms                      |

## Recommended settings for a remote database

- **Same region.** At 2 ms a turn costs +37 ms, at 40 ms +435 ms and +950 ms per tool round (tables above).
- **Pool size ≥ the number of instances that run a turn at the same time**, plus headroom for
  `listSessions`. With C2 one call can use the whole pool for a moment. Each running instance keeps one
  connection busy for each of its statements, back to back. With 20 instances streaming at 40 ms, a pool
  of 10 put the first token at 754 ms instead of 446 and slowed the stream (gap p95 152 ms); a pool of
  20 matched a single turn.
- **Keep connections**: pg's pool closes a connection idle for 10 s (`idleTimeoutMillis`), and a new
  one costs about 3 RTT here (127 ms at 40 ms) and about 7 RTT with TLS and SCRAM (inferred, about
  280 ms). Set `idleTimeoutMillis` to 60 s or more (or 0), `min` to the usual number of concurrent
  turns, and `keepAlive: true`.
- **`settings.progress`** (`createAgentRuntime({ settings })`): leave `partialIntervalMs` at 100. Raising it saves no statement
  and makes the stream choppy (585 ms gaps at 500). Raise `persistWithinMs` to 3000 to 5000 if losing
  that much of a partial answer in a crash is acceptable: a 300-token turn goes from 16 statements to
  10 at 5000, with no latency change.
- **Lease**: the defaults (TTL 30 s, renewal every 10 s) suit a remote database. A renewal is one round
  trip, so even at 40 ms the deadline has more than 20 s of margin, and since S2 renewal traffic does not
  grow with the number of instances. A crashed process blocks its scopes for the TTL, so shorten it only
  if takeover speed matters. Each renewal still writes every held lease's row, which costs WAL and
  vacuum work, not round trips. Keep `renewIntervalMs` at most a third of the TTL, so that two lost
  renewals do not lose the lease.
- **Close idle instances** in the app (`instance.close()` after some idle time): the runtime keeps every
  instance it opened until `runtime.close()`.
- **A pooler** in transaction mode should work, since the storage holds no session state: no advisory
  lock outside `migrate()`, no named prepared statements. This was not tested, and it adds a hop to each
  of the round trips above.

## Since these numbers

Statement counts rerun on the sessions record (`runtime.sessions`, one document for an instance's
sessions), at 0 ms on a local Postgres 18.6; timings above were not retaken:

| operation                                             | statements (above → now) |
| ----------------------------------------------------- | ------------------------ |
| `listSessions`, 50 sessions, first call               | 51 → 1                   |
| `listSessions` again, same instance                   | 1 → 0                    |
| `events()` from a cursor one turn back, other runtime | 11 → 12                  |

Every other row is unchanged: opening an instance, `createSession`, the three turns and both history
attaches. The one more statement is the first session call after an open reading the sessions record,
which the instance then keeps; `listSessions` no longer loads one document per session (C2 is gone).
