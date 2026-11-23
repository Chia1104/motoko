# @chia1104/motoko-store-mysql

Motoko's store on MySQL 8.0.24 or later: storage and a single-writer lease, built on Drizzle. Many
agent instances share one fixed set of `agent_runtime_*` tables in the database the app's pool
connects to; each instance (a scope of `{ kind, name }`) gets its own pi-durable `Storage`, and
opening a new one is a row, never DDL.

```bash
pnpm add @chia1104/motoko-store-mysql @chia1104/motoko-node mysql2
```

`drizzle-orm` is this package's own dependency, so it works whatever Drizzle version the app uses. The
app hands over a mysql2 pool (`mysql2/promise`'s, or a callback pool's `.promise()`) created for Motoko
alone with `multipleStatements: true` (see [A pool of its own](#a-pool-of-its-own)), with a `utf8mb4`
connection character set, mysql2's default.

It is a shared-database store of
[`@chia1104/motoko-core/store`](../core#shared-database-stores), like
[`@chia1104/motoko-store-postgres`](../store-postgres): the lease, the commit protocol and the
store's rules are the core's, and this package writes their MySQL statements, the storage's reads,
the schema and the migrations. Its error classes are the core's, so `instanceof` holds across every
such store.

## Use

```ts
import { createAgentRuntime } from "@chia1104/motoko-core";
import { nodeHost } from "@chia1104/motoko-node";
import { createMysqlStore } from "@chia1104/motoko-store-mysql";
import mysql from "mysql2/promise";

// Motoko's own pool: see "A pool of its own".
const pool = mysql.createPool({ uri: process.env.DATABASE_URL, multipleStatements: true });
const store = createMysqlStore(pool);

const runtime = createAgentRuntime({ agents, host: nodeHost(store), models, ports, closeIdleAfterMs: 60_000 });
// Take over what a previous process left; again every lease TTL or so, for one that crashed.
await runtime.recover();
```

[`examples/server.ts`](examples/server.ts) is a whole server. `store` behaves as the Postgres store
does, and its README describes `lease`, `storage`, `release(wake)`, `unfinished`, `erase` and
`deleteScope`. What differs on MySQL:

- MySQL has no `RETURNING` and no data-modifying CTEs, so a commit's write is a transaction rather
  than one statement, sent as one multi-statement query: one round trip, as on Postgres. Its first
  statement is the guard: an `UPDATE` of the scope's row that advances its counters only while the
  lease's token is current and unexpired by the database clock and `next_seq` is unchanged, and stamps
  a fresh nonce on the row. The plan's rows follow, one multi-row statement per table, each writing
  only where the row holds that nonce, then a read of the row that says how the write ended. So a
  refused guard writes nothing, even when another storage under the same lease moved `next_seq` to the
  value this write would have left, and a held one locks the scope's row until `COMMIT`.
- A statement that fails in the middle of a transaction leaves it open on its connection, so that
  connection is destroyed, never returned to the pool: the server rolls the transaction back, and the
  failure is the commit's as any statement's is, an unknown outcome when it is transient.
- Acquiring a lease is one transaction: an upsert that inserts the scope's row with the lease, or takes
  the free lease of the row that exists, stamping a nonce of its own on it, then a read of the row, which
  holds that nonce exactly when the lease is the acquirer's.
- A writer stalled in the middle of its commit's transaction holds the scope's row, so another
  holder's takeover waits for that transaction to end (or for `innodb_lock_wait_timeout`) instead of
  overtaking it.
- `store.erase()` reads what each conversation owns, then deletes it in one transaction, fenced as a
  commit is and only if no commit changed the scope since the read (its `next_seq`); after one, it
  reads again. It takes two round trips, not one: MySQL refuses a `DELETE` whose subqueries read the
  table it deletes from, so the deletes cannot find the conversations by themselves.

Round trips, which is what a database across a network charges for, as the tests count them:

| Operation                                            | Round trips                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `store.lease()`                                      | 1, held or not: the upsert and the read (with the schema check), as one transaction                     |
| `store.storage()`                                    | 1                                                                                                       |
| `release(wake)`                                      | 1, recording the wake                                                                                   |
| `store.unfinished()`                                 | 1 schema check, then 1 per 500 scopes listed                                                            |
| `store.erase()`                                      | per conversation, 2: the read, then the fence and up to 4 deletes as one transaction (1 when it skips)  |
| `store.deleteScope()`                                | 1 schema check, then 1: the delete and a read that names the holder, as one transaction                 |
| a commit                                             | 2: the read, then the write: the guard, 1 statement per table written and the outcome, as a transaction |
| a commit whose guard refuses                         | the same 2: the write's last statement says why                                                         |
| loading a document (`findDocument`, then `document`) | 1: the find reads the content too                                                                       |
| lease renewal                                        | 1 per store per `renewIntervalMs`; 2 when a lease was not extended, to learn why                        |

A group of batches costs two round trips, however many batches and tables it holds: a streamed chunk
(a document delta and the task's checkpoint) is the read, then a write of the guard, two inserts and
the outcome. A document copy adds two, since the copy's source is read after the batches before it are
written. One question and answer through pi-durable's Harness takes 5 commits and 10 round trips
here, as on Postgres.

A renewal reads the leases' rows only when it extended fewer than all of them: reading them in every
renewal would cost that read at every interval, to save a round trip only when a lease is lost.

What the statements assume of the server, besides the version: a `sql_mode` without
`NO_BACKSLASH_ESCAPES` (see below), and, when it writes a binary log, `binlog_format` `ROW` (the
default) or `MIXED`. The rows of a commit and the lease's upsert are
`INSERT ... SELECT ... ON DUPLICATE KEY UPDATE`, which MySQL marks unsafe for statement-based
logging (note 1592) and `MIXED` logs as rows.

## A pool of its own

`createMysqlStore` takes only a pool created with `multipleStatements: true`, and throws a `TypeError`
for any other: the store sends a transaction as one multi-statement query, so that it costs one round
trip. There is no other way to send them.

Give Motoko a pool that nothing else uses. Multiple statements widen what an SQL injection can do: a
query that splices untrusted text into its SQL lets that text end the statement and run others of its
own, where without the flag it could only change the one statement. Motoko splices no value: it binds
every one as a parameter. Code that shares the pool may not, so it would run with that wider blast
radius.

mysql2 escapes bound parameters into the query text itself, with backslashes, which is sound only while
the server's `sql_mode` lacks `NO_BACKSLASH_ESCAPES`. Every app that sends parameters through mysql2's
`query()` assumes this; with multiple statements, a server that breaks it lets a value run statements.

## Schema

- Records are JSON text in `LONGTEXT`: MySQL's `JSON` type rewrites the text (key order, numbers),
  and `TEXT` holds only 64 KB. pi-durable's JSON-encoded lone surrogates and NUL are stored as written.
- Indexed strings hold the JSON encoding of the string in `utf8mb4_0900_bin` columns, which compare
  and order by the bytes of their UTF-8 encoding and pad nothing (`'a'` and `'a '` differ). An InnoDB
  index key holds at most 3072 bytes, 4 per character, so each has the length its indexes leave it,
  in characters of its JSON encoding (`INDEXED_LENGTHS`): a task's kind and a submission's request ID
  760, a document's kind 256 and its key 500. A commit that holds a longer one rejects before it
  writes anything.
- A scope's kind and name hold up to 1024 characters each, which no index key fits: their unique key
  is a generated `scope_key`, the SHA-256 of the kind, a NUL and the name.
- The lease's expiry and every time are `DATETIME(3)` in UTC by the database clock
  (`UTC_TIMESTAMP(3)`), which no session `time_zone` converts. Drizzle reads them as UTC too.
- Integers are `BIGINT` and at most 2^53.
- MySQL has no partial index: generated columns stand in for Postgres's (`unfinished` on the scopes,
  `marker_id` on the entries).

What needs which MySQL version (the package is tested on 8.4.13, 8.0.46 and 8.0.24):

| Feature                                                                                         | Since  |
| ----------------------------------------------------------------------------------------------- | ------ |
| Altering a table with an expression default (the init migration's `CREATE INDEX` on the scopes) | 8.0.24 |
| Table value constructors (`VALUES ROW(...)`, a write's rows)                                    | 8.0.19 |
| `utf8mb4_0900_bin` (byte order, no padding)                                                     | 8.0.17 |
| Enforced `CHECK` constraints                                                                    | 8.0.16 |
| `LATERAL` derived tables (an entry scan, a document read)                                       | 8.0.14 |
| Expression defaults (`DEFAULT (UTC_TIMESTAMP(3))`)                                              | 8.0.13 |
| `JSON_TABLE` (a commit's read)                                                                  | 8.0.4  |
| The `SET_VAR` hint (fork chains deeper than 1000)                                               | 8.0.3  |
| Recursive CTEs (fork chains, erase)                                                             | 8.0.1  |

Before 8.0.24, MySQL refuses any `ALTER TABLE` or `CREATE INDEX` on a table that has a `NOT NULL` column
with an expression default, with `Invalid default value for 'created_at'`. The init migration creates the
scopes with `created_at DEFAULT (UTC_TIMESTAMP(3))` and indexes them after, so it stops there.

MySQL 8.4 plans `chain JOIN LATERAL (... LIMIT 1) ORDER BY ord LIMIT 1` by keeping one row of the
chain before the join, which finds nothing past the first fork segment. The storage never writes that
shape; the code says where it would.

## Migrations

The tables are created and upgraded by SQL files this package ships in `migrations/`, generated by
drizzle-kit from `src/schema.ts` and applied by Drizzle's migrator. Its journal is a table of its own
(`agent_runtime_migrations`), apart from the app's.

```bash
# at deploy time; reads AGENT_RUNTIME_DATABASE_URL or DATABASE_URL
pnpm exec motoko-store-mysql migrate
pnpm exec motoko-store-mysql check
```

or `await migrate(pool)` from code. Run it from the installed package: it reads the SQL files from the
package folder, which a bundle does not carry. A named lock (`GET_LOCK`) serializes concurrent
migrations of one database. MySQL commits each DDL statement by itself, so a migration that fails part
way leaves its earlier statements applied and is not recorded: drop what it created before running it
again.

Every lease, storage open and delete checks the database against the migrations this package lists (a lease
and a storage open within their own round trip) and rejects with `SchemaVersionError` when the
tables are missing, older, or migrated by a newer release. That check reads no file, so it works in a
bundled app. A database a newer release migrated is refused rather than written to: roll forward
instead of back.

Changing the schema: edit `src/schema.ts`, run `pnpm db:generate`, and add the new folder's name to
`src/shipped.ts`. Never edit a released migration.

## Other entries

- `@chia1104/motoko-store-mysql/schema`: the Drizzle tables, for reading the runtime's data with the app's
  own Drizzle instance. It loads no driver. Only the runtime writes these tables.

## Tests

```bash
vp run test                                           # offline: the migration files and the CLI's usage
TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:3306 vp run test   # a MySQL server the tests may create databases on
```

With a server, they run pi-durable's storage conformance suite unmodified, Motoko's host suite, and
the shared-database store suite of `@chia1104/motoko-core/store/testing`, with its other-process case.
Each test file creates and drops a database of its own.
