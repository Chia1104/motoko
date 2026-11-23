# @chia1104/motoko-store-postgres

Motoko's store on Postgres: storage and a single-writer lease, built on Drizzle. Many agent instances
share one fixed set of tables in the `agent_runtime` schema; each instance (a scope of `{ kind, name }`) gets
its own pi-durable `Storage`, and opening a new one is a row, never DDL.

```bash
pnpm add @chia1104/motoko-store-postgres @chia1104/motoko-node pg
```

`drizzle-orm` is this package's own dependency, so it works whatever Drizzle version the app uses. The
app hands over the `pg` `Pool` it already has.

It is a shared-database store of
[`@chia1104/motoko-core/store`](../core#shared-database-stores): the lease, the commit protocol and
the store's rules are the core's, and this package writes their Postgres statements, the storage's
reads, the schema and the migrations. Its error classes are the core's, so `instanceof` holds across
every such store.

## Use

```ts
import { createAgentRuntime } from "@chia1104/motoko-core";
import { nodeHost } from "@chia1104/motoko-node";
import { createPostgresStore } from "@chia1104/motoko-store-postgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresStore(pool);

const runtime = createAgentRuntime({ agents, host: nodeHost(store), models, ports, closeIdleAfterMs: 60_000 });
// Take over what a previous process left; again every lease TTL or so, for one that crashed.
await runtime.recover();
```

`store` is a Motoko store, and `nodeHost(store)` of `@chia1104/motoko-node` makes it the host of a
long-lived process (`wake: { kind: "process" }`). Its lease and storage come only as a pair: the
storage fences every commit with the lease's row, so a lease from anywhere else would fence nothing,
and the storage refuses one. Splitting the pair, such as `nodeHost({ storage: store.storage })`, does
not type-check, and throws a `TypeError` at the first open.

- `store.lease(scope)` acquires the scope's lease row and rejects with `LeaseHeldError` (a
  subclass of the runtime's) while another holder's lease is unexpired. The lease renews itself and is
  lost when a renewal shows it taken or expired, or when nothing was confirmed within its TTL (default
  30 s, which is also how long a crashed holder blocks its scope). A store renews all the leases it
  holds in one statement per `renewIntervalMs` (default TTL / 3), however many instances are open.
  The lease row names its `holder` (default `hostname:pid`). A cluster of Node servers that forward
  calls to each other sets it to the node's URL: see
  [Forwarding](../node#forwarding-experimental) in `@chia1104/motoko-node`.
- `store.storage(scope, lease)` opens the storage under that lease. Every commit is one guarded
  statement that also checks the lease's token and expiry by the database clock, so a writer that lost
  the lease writes nothing.
- `release(wake)` of a lease records, in the same statement that frees the scope, what the instance
  left (`wake_active`, `wake_at`: work that can run, and its earliest sleep).
- `store.unfinished()` lists the scopes `runtime.recover()` opens: those released with work that
  can run or a sleep, and those whose holder never released them (it crashed or lost its lease), once
  their lease has expired. A scope held now is its holder's to carry on. One statement per 500 scopes,
  on a partial index.
- `store.erase(scope, lease, conversations)` erases the sessions the runtime deleted, once the
  instance's storage is closed: each conversation, the conversations its tasks made, and their
  entries, tasks, submissions, documents and revisions, in one statement each. The statement is
  fenced as a commit is (it locks the scope's row and requires the lease's token, unexpired), and it
  leaves a conversation that still has unfinished work or that another forks from. Record IDs stay
  claimed, so none is handed out twice.
- `store.deleteScope(scope)` removes everything a scope owns. To delete a scope you hold, pass its lease
  from `store.lease()`.

Round trips, which is what a database across a network charges for:

| Operation                                            | Statements                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `store.lease()`                                      | 1 (2 when the lease is held, to name the holder)            |
| `store.storage()`                                    | 1                                                           |
| `release(wake)`                                      | 1, recording the wake                                       |
| `store.unfinished()`                                 | 1 per 500 scopes listed                                     |
| `store.erase()`                                      | 1 per conversation                                          |
| a commit, whatever it holds                          | 2: one read, one guarded write (one more per document copy) |
| loading a document (`findDocument`, then `document`) | 1: the find reads the content too                           |
| lease renewal                                        | 1 per store per `renewIntervalMs`                           |

[`bench/`](bench/README.md) measures the runtime on this storage at 0 to 40 ms round trips and
recommends settings for a remote database (`pnpm bench`).

## Migrations

The tables are created and upgraded by SQL files this package ships in `migrations/`, generated by
drizzle-kit from `src/schema.ts` and applied by Drizzle's migrator. Its journal is in a schema of its own
(`agent_runtime_drizzle`), apart from the app's.

```bash
# at deploy time; reads AGENT_RUNTIME_DATABASE_URL or DATABASE_URL
pnpm exec motoko-store-postgres migrate
pnpm exec motoko-store-postgres check
```

or `await migrate(pool)` from code. Run it from the installed package: it reads the SQL files from the
package folder, which a bundle does not carry.

Every lease, storage open and delete checks the database against the migrations this package lists (a lease
and a storage open within their own one statement) and
rejects with `SchemaVersionError` when the tables are missing, older, or migrated by a newer release.
That check reads no file, so it works in a bundled app. A database a newer release migrated is refused
rather than written to: roll forward instead of back.

Changing the schema: edit `src/schema.ts`, run `pnpm db:generate`, and add the new folder's name to
`src/shipped.ts`. Never edit a released migration.

## Other entries

- `@chia1104/motoko-store-postgres/schema`: the Drizzle tables, for reading the runtime's data with the app's
  own Drizzle instance. Records are JSON in `text` columns, not `jsonb`, because pi-durable stores
  strings jsonb rejects. Only the runtime writes these tables.
- `@chia1104/motoko-store-postgres/pglite`: the same store over a PGlite instance, for tests and local
  development. The root entry never loads PGlite.

## Tests

```bash
vp run test                                           # PGlite, offline
TEST_DATABASE_URL=postgres://… vp run test            # also a real Postgres
```

Both run pi-durable's storage conformance suite unmodified, Motoko's host suite, and the
shared-database store suite of `@chia1104/motoko-core/store/testing`. Against a real Postgres each
test file creates and drops a database of its own; the cross-connection lease cases run only there.
