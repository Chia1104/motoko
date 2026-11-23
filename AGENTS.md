# Motoko

An AI-agent runtime on pi-durable, published as the `@chia1104/motoko-*` packages in `packages/`. Before changing a
package, read its `AGENTS.md`. Each package's README is its spec, and tests cite its sections: a change in behaviour
updates the README in the same change.

## Commands

Run from the root with Vite+ (`vp`):

- `vp check`: format, lint and type-aware lint. `vp check --fix` formats and applies safe fixes.
- `vp run -r typecheck`, `vp run -r test`, `vp run -r build`.
- `vp run ready`: the four above, in order. CI runs these plus each store's `check:package`.

Tests run offline on pi-ai's faux provider, against the workspace sources (the `@chia1104/motoko-source` export
condition), so nothing needs building first. The stores' real-database cases run only when `TEST_DATABASE_URL` and
`TEST_MYSQL_URL` are set. CI sets both; set them yourself before calling a store change done:

```bash
docker run -d --rm --name motoko-pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17
docker run -d --rm --name motoko-mysql -e MYSQL_ROOT_PASSWORD=pw -p 3306:3306 mysql:8.4
TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/postgres TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:3306 vp run -r test
```

## Rules across packages

- pi (`@earendil-works/*`) is the app's own dependency: every package takes it as a `peerDependency` at `~1.6.0`, and
  core re-exports none of it.
- `wire` and `core` run in a browser, Electron or a Durable Object, and `client` in a browser: their `src/` uses no
  `node:*` import and no Node global.
- A library reports through the app's `onReport`. `console` is for CLIs, examples, benches and scripts only.
- `packages/node/test/workspace.test.ts` enforces the import rules above for every package.
- A README whose usage example lives in `examples/` shows the file verbatim, and a test compares them. Edit the example,
  then paste it into the README unchanged. The formatter leaves Markdown code blocks as written.

## Words

The code uses these words precisely:

- **instance**: one named agent of a kind, worked on by one writer at a time. Its **scope** is the kind and name that
  identify it and everything it stores.
- **session**: one conversation within an instance. A **run** is the agent's work from one user message until it
  answers, fails or is aborted.
- **store**: storage plus a single-writer lease. A **host** is a store plus wake-ups.
- **home**: wherever an instance's lease is held. Every call and reader of the instance is served there.
- **ports**: the app's capabilities that tools call, resolved for the caller who owns the instance.

## Commits

Conventional Commits, scoped by package directory: `feat(core):`, `fix(store-mysql):`, `test(client):`. `store`
covers both SQL stores; a change across several packages takes no scope. The subject states the behaviour in plain
words, such as `feat(client): keep a follow five seconds after its last follower leaves`. A test that pins a bug lands
as its own `test(...)` commit before the `fix(...)`. A breaking change takes `!` and a `BREAKING CHANGE:` footer
saying what the app must do.

Docs, code comments and commit messages are in English.
