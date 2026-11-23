# Motoko

An AI-agent runtime for apps built on pi. Its shape follows the Cloudflare Agents SDK: named agent
instances, sessions, a host that supplies storage and wake-ups, and a typed client event stream.
pi-durable is the only execution engine.

## Features

- **One agent definition, any host.** The same definition runs in an Electron process on SQLite, a
  Node server on Postgres or MySQL, or a Cloudflare Durable Object on its own SQLite. A host supplies
  only three things per instance: storage, a single-writer lease and wake-ups.
- **Restarts and crashes lose no committed work.** pi-durable commits every message, tool call and
  decision before anything is shown. Opening an instance carries on what the last process left, and
  `runtime.recover()` reopens unfinished instances after a restart without waiting for a call.
- **Approvals that outlive the process.** A call waiting for approval is parked in committed state,
  so it can still be approved or declined after a restart. Each session can run with a subset of the
  agent's tools and its own approval rule.
- **Each caller gets their own instance.** A multi-user server resolves models and ports (the app's
  capabilities that tools call) from the instance's scope, so a run resumed after a restart finds its
  caller's credentials again and never anyone else's. Instances nobody uses close and release their
  leases.
- **Steer a run while it is going.** A message sent during a run either joins it once the current
  tool round has its results, or waits as a follow-up that starts the next run. A queued message can
  be withdrawn before the agent reads it.
- **Agents that work together.** A delegate runs a sub-agent in a child session and returns its
  answer as the tool's result. A deferred tool asks another instance and waits for its reply. Neither
  holds a process while it waits.
- **One client, resumable by cursor.** Each session's events come from committed state. The client
  folds them into a view and resumes from its cursor after a dropped connection or a server restart,
  over a WebSocket to a Durable Object or HTTP and SSE to a Node server. `/react` adds a hook.
- **Several Node servers on one database (experimental).** An instance runs on whichever node holds
  its lease. A node refused the lease forwards the call there in one hop, with no message queue.
- **pi stays the app's own dependency.** Every `@earendil-works/*` package is a peer dependency at
  `~1.6.0`, so the app installs pi once and imports models, providers and storages from it directly.

## Packages

| Package                                                      | What                                                                             | Runs in                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------- |
| [`@chia1104/motoko-core`](packages/core)                     | Agent definitions, the host contract and `createAgentRuntime`                    | anywhere without Node built-ins |
| [`@chia1104/motoko-node`](packages/node)                     | A host for Node or Electron: SQLite per scope, a process lease, HTTP and SSE     | Node ≥ 22.19                    |
| [`@chia1104/motoko-store-postgres`](packages/store-postgres) | A Postgres store (storage and lease) on Drizzle, with migrations                 | Node ≥ 22.19                    |
| [`@chia1104/motoko-store-mysql`](packages/store-mysql)       | A MySQL 8.0.24+ store (storage and lease) on Drizzle, with migrations            | Node ≥ 22.19                    |
| [`@chia1104/motoko-cloudflare`](packages/cloudflare)         | An Agents SDK capability on a Durable Object's SQLite and alarm                  | a Cloudflare Durable Object     |
| [`@chia1104/motoko-client`](packages/client)                 | The browser client over a WebSocket or HTTP and SSE, with a React hook           | a browser                       |
| [`@chia1104/motoko-wire`](packages/wire)                     | Wire events, cursors, the `applyEvent` reducer and the call and socket protocols | anywhere (only zod)             |

## Install

```bash
pnpm add @chia1104/motoko-core @chia1104/motoko-node \
  @earendil-works/pi-durable@~1.6.0 @earendil-works/pi-ai@~1.6.0 \
  @earendil-works/chord@~1.6.0 @earendil-works/pi-schema@~1.6.0
```

## License

[MIT](LICENSE)
