# @chia1104/motoko-node

The host for a long-lived Node or Electron process (Node ≥ 22.19, for `node:sqlite`): `nodeHost`, `sqliteStore` with
a SQLite file per scope and an in-process lease, and `motokoHandler`, which serves calls over HTTP and session events
over SSE.

- Forwarding (`src/forward.ts`) is experimental. An instance has one home, the node holding its lease, and the lease
  row's `holder` is that node's internal URL. A node refused the lease forwards the request there in one hop, with the
  call protocol a browser uses. pi-durable commits before it shows and the lease already routes, so forwarding stays a
  direct hop with no message queue. Its end-to-end tests are in `packages/cluster-tests`.
- `test/workspace.test.ts` guards the whole workspace: each package's allowed imports, pi as a peer at `~1.6.0`,
  core's export list, and every README example shown verbatim. When a boundary changes on purpose, update it here.
- `test/crash.test.ts` runs an agent in a child process (`test/fixtures/crash-child.ts`), kills it with `SIGKILL`, and
  reopens its storage.
- `examples/server.ts` appears verbatim in the README.
