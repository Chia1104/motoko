# @chia1104/motoko-core

The runtime: `defineAgent`, `defineTool`, the host contract and `createAgentRuntime`. `src/engine/` holds the moving
parts (sessions, calls, approvals, asks and replies, the transcriber). `src/store/` is the shared-database store that
store-postgres and store-mysql build on.

## Invariants

- Everything a client sees comes from committed state, through the transcriber. What only `pi.live` shows (a streaming
  reply, a retry wait) is superseded by the stored events that follow it.
- A wait parks in committed state and holds no process. An approval, a delegate's child, a deferred call's reply and
  a sleep all park this way, so an idle close, a restart or an evicted Durable Object loses nothing.
- Core runs in a browser, Electron or a Durable Object: no `node:*` import and no Node global. Reach Node through a
  host.
- The `exports` map is exactly `.`, `./testing`, `./store`, `./store/testing` and `./sqlite`, and no module re-exports
  pi. `packages/node/test/workspace.test.ts` checks both. A new entry also needs `pack.entry` in `vite.config.ts`.

## Tests

Tests run offline on pi-ai's faux provider (`test/helpers.ts`), and each file tests what a README section says.
`examples/notes-agent.ts` and `examples/per-caller.ts` appear verbatim in the README.

`/testing` (the host conformance suite) and `/store/testing` (the shared-database store suite) run inside other
packages: node, cloudflare, store-postgres and store-mysql. After changing either, run those packages' tests too.
