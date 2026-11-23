# @chia1104/motoko-store-postgres

A Postgres store on Drizzle: pi-durable storage plus a single-writer lease, for many instances in one database. It
builds on core's shared-database store (`@chia1104/motoko-core/store`). `/pglite` runs the same store on PGlite,
`/schema` loads no driver, and a CLI migrates and checks.

store-mysql mirrors this package file for file. A change to one store's behaviour needs the same change in the other,
in its own dialect.

- A write runs only while the migrations journal holds exactly this package's migrations (`journalCheck` in
  `src/migrations.ts`), so the schema check comes before any write without a round trip of its own.
- `test/round-trips.test.ts` pins how many round trips each operation outside a commit costs. `bench/` measures what
  they cost at a given latency.

## Migrations

drizzle-kit owns `migrations/`; formatting and lint skip it. To change the schema:

1. Edit `src/schema.ts`.
2. Run `pnpm db:generate` in this package. It writes the next migration folder.
3. Add that folder's name to `SHIPPED_MIGRATIONS` in `src/shipped.ts`. The version check reads this list, not the
   files. `test/schema.test.ts` fails until the two agree, and until drizzle-kit reports no pending diff.
4. A new migration breaks apps until they run `migrate()` or the CLI, so its commit takes `!` and a
   `BREAKING CHANGE:` footer naming the migration.

## Tests

`vp run test` runs on PGlite, offline. With `TEST_DATABASE_URL` set it also runs against a real Postgres, where each
test file creates and drops its own database and the cross-connection lease cases run. After `vp run build`,
`vp run check:package` checks the built package as an app sees it.
