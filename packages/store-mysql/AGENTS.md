# @chia1104/motoko-store-mysql

A MySQL 8.0.24+ store on Drizzle, the twin of store-postgres: the same lease, commit protocol and store rules, with
MySQL's statements. It builds on core's shared-database store (`@chia1104/motoko-core/store`). `/schema` loads no
driver, and a CLI migrates and checks.

A change to one store's behaviour needs the same change in store-postgres, in its own dialect.

## MySQL's constraints

- MySQL has no `RETURNING`. A transaction goes as one multi-statement query, to cost one round trip, so
  `createMysqlStore` takes only a pool created with `multipleStatements: true`. Bind every value as a parameter; the
  flag widens what spliced SQL text could do.
- Acquiring a lease stamps a fresh `commit_nonce` on the scope's row, and the read after it tells by the nonce
  whether the lease is the acquirer's.
- A write runs only while the migrations journal holds exactly this package's migrations (`journalCheck` in
  `src/migrations.ts`), so the schema check comes before any write without a round trip of its own.
- Indexed strings are `utf8mb4_0900_bin`, records `LONGTEXT`, times `DATETIME(3)` in UTC. A scope's unique key is a
  generated SHA-256 of kind and name, so 1024-character names fit InnoDB's index limit.
- The README's version table says which feature needs which MySQL version. A feature newer than 8.0.24 raises the
  minimum the README claims.

## Migrations

drizzle-kit owns `migrations/`; formatting and lint skip it. To change the schema:

1. Edit `src/schema.ts`.
2. Run `pnpm db:generate` in this package. It writes the next migration folder.
3. Add that folder's name to `SHIPPED_MIGRATIONS` in `src/shipped.ts`. The version check reads this list, not the
   files. `test/schema.test.ts` fails until the two agree, and until drizzle-kit reports no pending diff.
4. A new migration breaks apps until they run `migrate()` or the CLI, so its commit takes `!` and a
   `BREAKING CHANGE:` footer naming the migration.

## Tests

`vp run test` without a server checks only the migration files and the CLI's usage. Set
`TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:3306`, a server the tests may create databases on, for the rest; each test
file creates and drops its own database. `test/round-trips.test.ts` pins the statements the README's table states,
so a changed statement updates both. After `vp run build`, `vp run check:package` checks the built package as an app
sees it.
