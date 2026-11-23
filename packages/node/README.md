# @chia1104/motoko-node

The Motoko host for a long-lived process: an Electron backend or a Node server (Node 22.19 or
later, for `node:sqlite`). pi-durable's own timers wake sleeping work, and opening an instance
resumes whatever the previous process left unfinished: replay-safe tool calls run again, others are
reported to the model as interrupted, and calls parked for approval stay decidable. A server also
answers a browser: calls over HTTP, and each session's events as server-sent events.

## Usage

```ts
import { createServer } from "node:http";

import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "@chia1104/motoko-core";
import { motokoHandler, nodeHost, nodeListener, sqliteStore } from "@chia1104/motoko-node";

const clock = defineTool({
  name: "clock",
  description: "The current time",
  tier: "read",
  replay: "safe",
  parameters: z.object({ timeZone: z.string().optional() }),
  async execute({ timeZone }) {
    return { text: new Date().toLocaleString("en-US", timeZone === undefined ? {} : { timeZone }) };
  },
});

const assistant = defineAgent({
  kind: "assistant",
  instructions: "You are a helpful assistant.",
  tools: [clock],
  model: { provider: "openai", modelId: "gpt-6-sol" },
});

const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

const runtime = createAgentRuntime({
  agents: [assistant],
  // One SQLite file per instance: ./data/assistant/<user>.sqlite
  host: nodeHost(sqliteStore({ directory: "./data" })),
  models,
  ports: {},
  closeIdleAfterMs: 5 * 60_000,
});

// Carry on what the previous process left unfinished, in every instance, before any call comes.
await runtime.recover();

// The app's own sign-in goes here. This demo takes one token per user, as a cookie, which EventSource sends too.
const users = new Map([["demo-token", "user-42"]]);

const handler = motokoHandler(runtime, {
  basePath: "/motoko",
  // Who is calling, and so which instance: each user has their own.
  resolve(request) {
    const token = /(?:^|;\s*)token=([^;]*)/.exec(request.headers.get("cookie") ?? "")?.[1];
    const user = token === undefined ? undefined : users.get(token);
    if (user === undefined) return new Response("Sign in first", { status: 401 });
    return { agent: assistant, name: user };
  },
  // What the caller may do, call by call: here, anything but deleting a session.
  authorize: (_request, call) => call.method !== "deleteSession",
  onError: (error) => console.error(error),
});

const server = createServer(nodeListener(handler));
server.listen(3000, () => console.log("Motoko on http://localhost:3000/motoko"));

process.on("SIGTERM", () => {
  server.close();
  // A follow never ends on its own; its client reconnects to the next process after its last cursor.
  server.closeAllConnections();
  void runtime.close();
});
```

(`examples/server.ts`, typechecked with the package. Run it from this package with
`node --conditions=@chia1104/motoko-source examples/server.ts`, which reads the workspace's sources.)

## API

```ts
motokoHandler(runtime, { resolve, authorize?, onError?, basePath?, heartbeatMs?, maxBodyBytes?, cluster? }): (request: Request) => Promise<Response>
nodeListener(handler, { onError? }?): (req: IncomingMessage, res: ServerResponse) => void

interface ClusterOptions {                                // experimental: see "Forwarding"
  self: string;                                           // this node's internal base URL, and its lease holder
  peers: readonly string[] | ((holder: string) => boolean); // the holders it may forward to
  connectTimeoutMs?: number;                              // default 2 000
}
FORWARDED_BY = "motoko-forwarded-by"                      // the header a forward sets

interface MotokoTarget { agent: AgentDefinition | string; name: string } // what resolve answers, with the app's own fields
type HttpCall = Call | FollowCall                                         // what authorize decides on
interface FollowCall { method: "follow"; params: { sessionId: string; from?: Cursor } }

nodeHost(store: NodeStore): AgentHost                     // wake: { kind: "process" }
sqliteStore({ directory } | { path }, lease?): AgentStore // sqliteStorage with unfinished and erase
sqliteStorage({ directory } | { path }): StorageFactory
sqliteScopes(directory): AsyncIterable<StorageScope>     // every scope with a file under directory
eraseSqliteConversations(file, conversations, { prefix? })
processLeases: LeaseProvider                   // the default, shared by every nodeHost of the process
scopeFile(directory, scope) · scopeFileSegment(value)

type NodeStore<L extends Lease = Lease> = {              // an AgentStore, or a storage alone
  lease: (scope: StorageScope) => Promise<L>;            // optional when L is Lease, default: processLeases
  storage: (scope: StorageScope, lease: L) => Promise<Storage>;
  unfinished?: () => AsyncIterable<StorageScope>;
  erase?: (scope: StorageScope, lease: L, conversations) => Promise<void>;
}
type StorageFactory = (scope: StorageScope, lease: Lease) => Promise<Storage>;
type LeaseProvider = (scope: StorageScope) => Promise<Lease>;
```

`nodeHost(store)` adds the process's wake-ups to a store: one from `sqliteStore`, one from a database
package such as `@chia1104/motoko-store-postgres`, or the app's own. The store's storage and `erase`
get only the lease that its own `lease` returns. A store with no `lease` gets `processLeases`, so its
storage must take any lease. `sqliteStorage({ directory })` does. A storage that fences its commits
with its own lease, such as Postgres's, does not, so `nodeHost({ storage: store.storage })` of a
Postgres store does not type-check.

`sqliteStore` is the complete store on SQLite files: `sqliteStorage` under `lease` (default
`processLeases`), `erase` from `eraseSqliteConversations`, and, with `directory`, `unfinished` from
`sqliteScopes`.

`sqliteStorage` and `sqliteStore` also take `sqlite`, passed to pi-durable's `openNodeSqliteStorage` (for example a
table `prefix`). Any other pi-durable storage is a `StorageFactory` as it is: for tests and demos,
`storage: async () => new MemoryStorage()` with `MemoryStorage` from `@earendil-works/pi-durable`
(a fresh, empty storage at every open). pi-durable is a peer dependency at `~1.6.0`, as for
`@chia1104/motoko-core`.

## Calls and session events over HTTP

`motokoHandler(runtime, options)` serves the [call protocol](../wire#the-call-protocol) as a Fetch
handler, `(request: Request) => Promise<Response>`. It mounts in any framework that speaks `Request`
and `Response`, such as Hono or a Next.js route handler, and in Node's `http` through `nodeListener`.
Its two routes are under `basePath`:

| Route                                       | Request                                                 | Answer                                 |
| ------------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| `POST {basePath}/call`                      | `{ method, params }` as `application/json`              | `{ result }` or `{ error: CallError }` |
| `GET {basePath}/sessions/:sessionId/events` | the cursor to resume after: `Last-Event-ID` or `?from=` | the session's wire events, as SSE      |

A browser calls them with [`@chia1104/motoko-client`](../client)'s `httpTransport`, the same client
that talks to a Durable Object over its socket. It reads a follow's stream with `fetch` rather than
`EventSource`, so a follow sends the app's headers, such as `Authorization`, and it reconnects with
`Last-Event-ID` set to the client's cursor.

### Calls

The handler parses a call's body with wire's `callSchemas` and runs it with core's `runCall`. A
call that fails is answered with its `CallError` and this status:

| `code`                 | Status |
| ---------------------- | ------ |
| `invalid_request`      | 400    |
| `invalid_cursor`       | 400    |
| `forbidden`            | 403    |
| `session_not_found`    | 404    |
| `session_busy`         | 409    |
| `session_owned`        | 409    |
| `approval_not_pending` | 409    |
| `reply_not_pending`    | 409    |
| `internal`             | 500    |
| `instance_closed`      | 503    |
| `lease_held`           | 503    |

Four refusals of the handler's own also carry `invalid_request`. A path that is not a route is 404.
The wrong method is 405, with `Allow`. A call whose body is not `application/json` is 415, which
means a cross-site form cannot post a call without a CORS preflight. A call whose body is longer
than `maxBodyBytes` (default 1 MiB) is 413: the handler refuses a longer `Content-Length` before
reading any of it, and a body sent without one once it streams past the cap, then cancels the rest
unread. An error that is not one of the runtime's, such as a throw in `resolve`, goes to `onError`.
Its request is answered `internal` with the message `Internal error`, so no detail of it reaches the
client.

### Following a session

`GET .../events` answers `text/event-stream`. It sends the session's events after the cursor, then
each new event as it comes. Each event is one message without an event name, so EventSource
delivers it to `onmessage`:

```
id: 1.0.9.f0421efc541e40d7.1
data: {"sessionId":"1","cursor":"1.0.9.f0421efc541e40d7.1","event":{"type":"run:start"}}

```

`data` is wire's `followedEventSchema`, and `id` is the cursor right after the event. So the
browser's `lastEventId` is always the cursor of the last event the client received. The stream
carries two other frames:

- `event: ended`, with `data` as `followEndedSchema` (`{ sessionId, error }`), when the server stops
  following the session: it was deleted (`session_not_found`), or it cannot be read. The stream
  closes after it. Close the EventSource on `ended`. Otherwise the browser reconnects, and the
  reconnect is answered 404.
- `: heartbeat`, a comment line every `heartbeatMs` (default 15 000), so a proxy keeps a quiet stream
  open. EventSource ignores comments.

A stream that closes without `ended` means that the instance closed: the server shut down, or lost
the instance's lease. EventSource reconnects with `Last-Event-ID`, and whatever serves the instance
then resumes the client after its last event.

The cursor comes from the `Last-Event-ID` header, which EventSource sends when it reconnects, or from
the `from` query parameter, which a client sets for its first connection, since EventSource cannot set
headers. When a request has both, `Last-Event-ID` wins: EventSource reconnects to the URL it opened, so
its `from` is older. With neither, the stream starts at the session's start. Resuming follows core's
[cursor rules](../core#cursors): exact while the cursor's run is in this process's log, and from
committed state anywhere else.

Before the stream starts, the handler answers these with a call error and its status: a cursor that
is not one of the session's (400 `invalid_cursor`), a session that does not exist (404), and an
instance this process cannot open (503 `lease_held`). EventSource does not reconnect after a
refusal.

The body is read only as fast as the client takes it. When the client goes away (`request.signal`
aborts, or the body is cancelled), the handler stops the session's reader, so the instance closes
once idle (`closeIdleAfterMs`).

### Who may do what

Two of the app's functions decide, as on the Cloudflare socket:

- `resolve(request)` authenticates. It answers the instance the request is for, `{ agent, name }`,
  or a `Response` to refuse, such as a 401, which is sent as it is before anything runs. Its answer
  may carry more of the app's fields, such as the signed-in user, and `authorize` gets all of it as
  `target`.
- `authorize(request, call, target)` decides each request that `resolve` let through: every call,
  and every follow. `call` is an `HttpCall`, one of wire's `Call`s or a follow,
  `{ method: "follow", params: { sessionId, from? } }`, which `method` tells apart. Any answer but
  `true` is 403 `forbidden`, and nothing runs. Without `authorize`, the handler allows every call.
  To make a caller read-only, refuse each call whose `callSchemas[call.method].writes` is true. A
  follow writes nothing.

CORS is the app's: answer preflight requests before the handler, which answers `OPTIONS` with 405.

### Node's `http`

`nodeListener(handler)` is a request listener for `http.createServer` or `https.createServer`. It
turns each `IncomingMessage` into a `Request` whose body streams from the socket and whose `signal`
aborts when the client disconnects. It writes each `Response` with Node's `pipeline`, which reads the
body only as the socket drains, and cancels the body if the client goes away first. A handler that
rejects is answered 500, and the error goes to `onError`. `motokoHandler` answers its own errors.

A follow does not end on its own, so `server.close()` alone waits for it forever. Call
`server.closeAllConnections()` too, as the example does: each client then reconnects to the next
process after its last cursor.

## Forwarding (experimental)

Several Node servers can share one Postgres or MySQL store, so that a browser may call any of them.
Each instance runs on one node at a time, its home: the node that holds its lease. The lease row
names the home, because each node's store sets its lease `holder` to the node's internal URL. A
node that cannot open an instance because another node holds its lease forwards the request to that
node, with the call protocol a browser uses, and passes the home's answer back.
It needs no message queue, since the lease row already names each instance's home.

```ts
// This node's routes as the other nodes reach them, such as http://10.0.0.7:3000/motoko.
const self = process.env.MOTOKO_SELF!;
// The same URL of every node in the cluster.
const peers = process.env.MOTOKO_PEERS!.split(",");

const store = createPostgresStore(pool, { holder: self, ttlMs: 5_000 }); // or createMysqlStore(pool, { ... })
const runtime = createAgentRuntime({ agents, host: nodeHost(store), models, ports });
const handler = motokoHandler(runtime, { basePath: "/motoko", resolve, authorize, cluster: { self, peers } });
```

- `self` is the base URL of this node's routes, `basePath` included, at an address its peers can
  reach. The store's `holder` must be the same string. `createPostgresStore` and `createMysqlStore`
  both take `holder` in their options. Without it the holder is `hostname:pid`, which is not a URL,
  so no node forwards to it.
- `peers` is the list of every node's `self`, or a predicate of one holder. It is required, because
  a forward carries the caller's credentials. A node forwards only to a holder that `peers` names.
- `connectTimeoutMs` (default 2 000) is how long a forward waits to connect to the home.

### What a node forwards

A call or a follow is forwarded when its instance's open is refused with `LeaseHeldError` and the
holder is a peer, is not `self`, and is an http or https URL. Any other refusal is answered 503
`lease_held`, as without `cluster`. A forward sends the home this request:

- The same method, to the holder's URL followed by the request's path below `basePath` and its
  query.
- Every header of the request, credentials included, except those of its connection: `Host`,
  `Connection` and the headers it names, `Content-Length`, `Expect`, `Keep-Alive`,
  `Proxy-Authorization`, `Proxy-Authenticate`, `Proxy-Connection`, `TE`, `Trailer`,
  `Transfer-Encoding` and `Upgrade`.
- The call's body as the handler read it, within `maxBodyBytes`.
- One more header, `motoko-forwarded-by: <self>`.

Each forward opens a connection of its own, so a home that is gone fails the connect before
anything is sent.

A request that already carries `motoko-forwarded-by` is never forwarded again. The node that sent
it read this node as the home, and this node is not, so the lease moved meanwhile. It is answered
503 `lease_held`, and the client tries again.

The node that forwards runs `resolve` and `authorize` before it learns where the instance lives. The
home runs both again on the forwarded request.

An ask travels the same way. A deferred call's `start` submits with `replyTo` to any node, which
forwards it to the asked instance's home. When the asked run ends, that home's `deliverReply` sends
`reply` to any node with the asker's credentials, and it is forwarded to the asker's home. A
`deliverReply` that posts to its own node is enough:

```ts
deliverReply: async ({ to, text, isError }) => {
  const asker = motokoClient(httpTransport({ baseUrl: self, headers: credentialsOf(to.scope) }));
  try {
    await asker.reply(to.sessionId, { toolCallId: to.toolCallId, token: to.token, text, isError });
  } catch (error) {
    // Refused for good: the call waits for no reply, or its session is gone. Anything else is tried again.
    if (!(error instanceof MotokoError && ["reply_not_pending", "session_not_found"].includes(error.code))) throw error;
  }
},
```

`credentialsOf` is the app's: whatever its `resolve` and `authorize` accept for the asker's instance.

### What the client gets

| The home                                        | The answer                                                 |
| ----------------------------------------------- | ---------------------------------------------------------- |
| answers                                         | the home's status, headers and body, as the home sent them |
| accepts no connection within `connectTimeoutMs` | 503 `lease_held`, with `Retry-After`                       |
| got the request, and the connection broke       | an answer that breaks off where the home's did             |

The home's answer passes back whatever it is: a result, a call error, or the app's own refusal from
`resolve`, such as a 401 with its own body and headers. Only the headers of the connection and
`Content-Length` are left out. A connection that breaks before the home answers is a 502 whose body
breaks off at once. `httpTransport` rejects such a call with `connection_closed`, since it may have
run, and retries such a follow.

`Retry-After` is the whole seconds until the lease expires, by the node's clock, as the store read
the lease. A holder that is alive renews its lease before then, so a retry at that time may be
refused again.

A follow streams through: every event, heartbeat and `ended` comes from the home. When the client
goes away, the forwarding node ends its request to the home, and the home stops its reader. When the
home's stream ends without `ended` (the home shut down, or lost the lease), the forwarded stream ends
too. The client reconnects with `Last-Event-ID`, and the [cursor rules](../core#cursors) resume it
exactly, on whichever node is the home by then.

### What a forward costs

A forward adds one hop. The node that forwards first tries to take the lease (two statements, one
of them to name the holder), then sends the request to the home on a new connection.
`bench/failover.ts` in [`packages/cluster-tests`](../cluster-tests) measures it on one machine:
`listSessions` took 0.15 ms (median of 300) answered by the home. Through a peer it took 0.8 ms on
PGlite, and 1.3 ms and 6.5 ms in two runs on Postgres 17 in Docker. Between machines, add two
database round trips, a TCP handshake, and one request to the home. A load balancer that routes by
user, so that most calls reach the home, saves most forwards.

### Failover

A home that shuts down releases its leases in `runtime.close()`, and the next call on any node takes
the instance over at once. A home that crashes holds its leases until they expire, `ttlMs` after its
last renewal. Until then, the other nodes answer that instance's calls 503 `lease_held`. A cluster
should shorten `ttlMs` from the default of 30 seconds.

`bench/failover.ts` measures it: the home's store stops reaching the database and its server closes,
and another node calls every 5 ms until the instance answers. With `ttlMs: 1_000` (a renewal every
333 ms), 20 crashes on PGlite and 10 on Postgres 17 each took 0.69 to 1.01 seconds. Counted from the
home's last renewal instead, each took 0.97 to 1.03 seconds: the instance opened on the new home at
the first call after the lease expired. With `ttlMs: 3_000`, failover took 2.1 to 3.0 seconds.

A shorter TTL adds little traffic: each node's store renews all its leases in one statement every
`ttlMs / 3`, however many instances it holds. Its risk is that a home that cannot reach the database
for `ttlMs` loses its leases, and their instances close. `ttlMs: 5_000` keeps a crashed home's
failover to about 5 seconds.
`httpTransport` retries a follow after a 503 with its own backoff, which doubles from half a second,
so a follower may reconnect up to its current wait after the takeover. Run `runtime.recover()` on
each node every `ttlMs` or so, so that work a crashed home left carries on before the next call.

### Security

- A forward sends the caller's credentials to another server, so a node sends them only to a holder
  that `peers` names. A holder read from the database is never trusted alone: a stale row, or a row
  that someone else wrote, gets nothing.
- The home authenticates and authorizes every forwarded request again with its own `resolve` and
  `authorize`, and its refusal passes back unchanged. Nodes do not sign requests to each other, and
  `motoko-forwarded-by` grants nothing: it only stops a second forward. A client that sends it gets
  503 instead of a forward.
- A forward to an `http` peer is plain HTTP. Keep the peers on a private network, or give them
  `https` URLs, whose certificates Node verifies.
- A `lease_held` error's message names the holder, so a client can read a node's internal URL.

### What is not built

- Placement by hashing: an instance's home is the node that its first call after a free lease
  reaches.
- Fan-out: each follow is its own stream from the home, through one node.
- Rebalancing: an instance stays on its home until the home closes it (an idle close or a shutdown)
  or loses its lease.

## How scopes map to SQLite files

`sqliteStorage({ directory })` keeps each scope in its own file:
`<directory>/<kind>/<name>.sqlite`. Each segment keeps lowercase ASCII letters, digits, `_` and `-`
and writes every other UTF-8 byte as `%XX`, uppercase letters included, so the mapping is one to one
on case-insensitive file systems too (`Alice` is `%41lice.sqlite`, `alice` is `alice.sqlite`). A
segment longer than 120 characters keeps its first 80 and a SHA-256 digest of the whole value.

A digest cannot be read back, so for such a file `sqliteStorage` writes its scope beside it, in
`<name>.scope.json`, which is how `sqliteScopes` names it.

One file per scope, rather than table prefixes in one shared file, because each instance is its own
Harness with its own connection: separate files never contend for SQLite's write lock, a scope can be
copied, backed up or erased by deleting a file, and closing one instance's storage never touches
another's. `sqliteStorage({ path })` accepts any other layout; two scopes must never share a file
without distinct table prefixes and a shared connection, which this package does not set up.

## The lease

The default lease is in-process: one writer per scope across every `nodeHost` in the process, so two
runtimes in one process never both write a scope. It is `@chia1104/motoko-core`'s `inProcessLeases()`, made once
for the process; a host that needs a lease table of its own passes `lease: inProcessLeases()`. It
cannot see other processes: pi-durable has no cross-process locking, and SQLite's file locks do not
make two Harnesses on one file safe. A deployment where two processes may open the same storage
passes its own `lease` (a lock file, a database advisory lock) whose `signal` aborts when the lock
is lost; the runtime then closes the instance at once.

## Idle instances on this host

With the runtime's `closeIdleAfterMs`, an instance that went idle closes its SQLite connection and
releases its lease, so a runtime in another process (with a lease that reaches it) can take the scope;
the app's handles reopen it at their next call. This host's wake style is `process`, so the runtime
itself reopens an instance closed with a sleep due later (a retry backoff, for example) when the
sleep is due, and that timer keeps the Node.js process alive as pi-durable's own would. A
`MemoryStorage` factory starts empty at every open, so it loses an idle instance's sessions: pair
idle closing with a storage that outlives the instance, such as `sqliteStorage`.

## Recovering and erasing on this host

A SQLite file records nothing of what its last instance left, so `sqliteScopes(directory)`, the
`unfinished()` of `sqliteStore({ directory })`, lists every scope that has a file. `runtime.recover()`
opens each, which carries on whatever it left, and with `closeIdleAfterMs` the ones with nothing to do
close again once idle. Fine for an app with a handful of instances, as an Electron app has; a server
with many instances per file directory pays one open each at every `recover()`.

`eraseSqliteConversations(file, conversations)` is what `sqliteStore` erases deleted sessions with:
each conversation, the conversations its tasks made, and their entries, tasks, submissions and
documents, in one transaction on a connection of its own, while the instance's storage is closed.
The statements are `eraseConversations` of `@chia1104/motoko-core/sqlite`, which write pi-durable's
tables directly, against its SQLite schema version 2 (pi-durable 1.6), and refuse a file in any other
version, changing nothing. Around them it turns on SQLite's `secure_delete` and truncates the
write-ahead log, so the erased text is overwritten in the file, not only unlinked. A conversation that
still has unfinished work, or that another conversation forks from, is left for the next close.
