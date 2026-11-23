# @chia1104/motoko-cloudflare

Motoko in a Cloudflare Durable Object, as an Agents SDK capability. `MotokoCapability` runs one
instance, the one whose scope is the object (`{ kind: agent.kind, name: <the object's name> }`), on a
host made of the object's SQLite database (the store) and its alarm (the wake-up), through the
Lifecycle's job queue. It installs on an `Agent` or on a plain Durable Object with the `Lifecycle`,
beside the SDK's own capabilities: the scheduler, state and WebSockets share the one alarm with it,
and none overwrites another's.

Browsers reach the instance over the object's WebSockets, on the socket the Agents SDK's client
already opens. The capability serves Motoko's socket protocol there beside the app's own frames, and
[`@chia1104/motoko-client`](../client)'s `webSocketTransport` speaks it: its client follows a
session's wire events by cursor, folds them into a session view and makes the calls an app needs, and
its `/react` puts a hook on top. The same client runs over HTTP to a Node server, so the browser code
does not change with the host.

The Agents SDK and pi are peers: `agents` within one minor, `>=0.34.0 <0.35.0` (each minor supports
one pi minor, and 0.34 supports pi `~1.6.0`), and the `@earendil-works/*` packages at `~1.6.0`.

```bash
pnpm add @chia1104/motoko-cloudflare @chia1104/motoko-core agents@~0.34.0 \
  @earendil-works/pi-durable@~1.6.0 @earendil-works/pi-ai@~1.6.0 \
  @earendil-works/chord@~1.6.0 @earendil-works/pi-schema@~1.6.0
# the browser's side
pnpm add @chia1104/motoko-client
```

The object's class is SQLite-backed (`new_sqlite_classes` in its Wrangler migration) and addressed by
name (`getByName`, `idFromName`), since the name is half of its instance's scope.

## Usage

The object, and the Worker that routes each user to their own:

```ts
// pi and the Agents SDK are the app's own dependencies: its models come from them directly.
import { createModels } from "@earendil-works/pi-ai/models";
import { Agent, routeAgentRequest } from "agents";
import { createAI } from "agents/models/pi-ai";
import type { AI } from "agents/models/pi-ai";
import * as z from "zod";

import { MotokoCapability } from "@chia1104/motoko-cloudflare";
import { defineAgent, defineTool } from "@chia1104/motoko-core";
import type { ToolContext } from "@chia1104/motoko-core";

// The Worker's bindings, from its Wrangler configuration.
interface Env extends Cloudflare.Env {
  readonly AI: Ai;
  readonly NOTES: DurableObjectNamespace<NotesAgent>;
}

// ─── The definition: no ports, no credentials. ────────────────────────────────

interface NotesPorts {
  /** The object's own key-value storage, beside Motoko's tables. */
  readonly notes: SyncKvStorage;
}

const readNote = defineTool({
  name: "read_note",
  description: "Read a note by its key",
  tier: "read",
  replay: "safe",
  parameters: z.object({ key: z.string() }),
  async execute({ key }, { ports }: ToolContext<NotesPorts>) {
    return { text: ports.notes.get<string>(`note:${key}`) ?? "" };
  },
});

const writeNote = defineTool({
  name: "write_note",
  description: "Write a note",
  tier: "write",
  parameters: z.object({ key: z.string(), text: z.string() }),
  async execute({ key, text }, { ports }: ToolContext<NotesPorts>) {
    ports.notes.put(`note:${key}`, text);
    return { text: `Saved ${key}.` };
  },
});

const notesAgent = defineAgent<NotesPorts>({
  kind: "notes",
  instructions: "You keep the user's notes. Ask before writing one.",
  tools: [readNote, writeNote],
  policy: { requiresApproval: ["write"] }, // write-tier calls wait for the user
});

// ─── One object per user: its instance's scope is { kind: "notes", name: <the object's name> }. ─

/** pi-ai model access over Workers AI and AI Gateway: the Worker holds no provider key. */
function modelsOf(ai: AI) {
  const models = createModels();
  models.setProvider(ai.provider);
  return models;
}

export class NotesAgent extends Agent<Env> {
  readonly #ai = createAI({ binding: this.env.AI });
  readonly #model = this.#ai("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
  readonly motoko = new MotokoCapability<NotesPorts>({
    agent: notesAgent,
    models: modelsOf(this.#ai),
    defaultModel: { provider: this.#model.provider, modelId: this.#model.id },
    ports: { notes: this.ctx.storage.kv },
    // Motoko's socket protocol on the agent's own WebSockets, beside the app's frames: no onMessage to write.
    connections: this,
    // Closes the instance once idle (no socket following a session), which also erases the sessions the user deleted.
    closeIdleAfterMs: 60_000,
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.motoko);
  }

  // An RPC method of the app's, for its other Workers: the Agent starts its Lifecycle before each runs.
  async ask(sessionId: string, text: string, requestId: string): Promise<string> {
    const instance = await this.motoko.instance();
    return (await instance.session(sessionId).submit({ text, requestId })).submissionId;
  }
}

/** The signed-in user, by the app's own sign-in: a session cookie it verifies, say. Not Motoko's. */
declare function signedInUser(request: Request, env: Env): Promise<string | null>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Every connection to an object may make every call on its sessions, so the app lets each user reach their own
    // object alone (`/agents/notes/<user>`), before the request reaches it.
    const ownObjectOnly = async (incoming: Request, route: { readonly name: string }) => {
      const user = await signedInUser(incoming, env);
      if (user === null) return new Response("Unauthorized", { status: 401 });
      if (route.name !== user) return new Response("Forbidden", { status: 403 });
      return undefined;
    };
    const routed = await routeAgentRequest(request, env, {
      onBeforeConnect: ownObjectOnly,
      onBeforeRequest: ownObjectOnly,
    });
    return routed ?? new Response("Not found", { status: 404 });
  },
};
```

(`examples/notes-agent.ts`, typechecked with the package.)

The browser, with React:

```tsx
// The browser side: the Agents SDK's socket to the user's NotesAgent, and Motoko's session over it.
import { useAgent } from "agents/react";
import { useState } from "react";

import { motokoClient, webSocketTransport } from "@chia1104/motoko-client";
import { useMotokoSession } from "@chia1104/motoko-client/react";

export function NotesSession({ user, sessionId }: { readonly user: string; readonly sessionId: string }) {
  // The binding `NOTES` in kebab case, and the object named after the user: the routing Worker admits them alone.
  const agent = useAgent({ agent: "notes", name: user });
  // The socket's one client, the same at every render; over HTTP to a Node server it would be httpTransport's.
  const motoko = motokoClient(webSocketTransport(agent));
  // The session's view, folded from its events; after a reconnect it resumes from the last cursor it folded.
  const { view, status, submit, decide } = useMotokoSession(motoko, sessionId);
  const [draft, setDraft] = useState("");

  return (
    <section>
      {status === "connecting" && <p>Connecting…</p>}
      {status === "ended" && <p>This session is gone.</p>}
      {view.items.map((item) => {
        if (item.kind === "user" || item.kind === "assistant") {
          return <p key={item.messageId}>{item.text}</p>;
        }
        if (item.kind !== "tool") return null;
        const waiting = view.pendingApprovals.includes(item.toolCallId);
        return (
          <p key={item.toolCallId}>
            {item.label}: {item.status}
            {waiting && (
              <>
                <button onClick={() => void decide([{ toolCallId: item.toolCallId, approved: true }])}>Allow</button>
                <button onClick={() => void decide([{ toolCallId: item.toolCallId, approved: false }])}>Deny</button>
              </>
            )}
          </p>
        );
      })}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(draft);
          setDraft("");
        }}
      >
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </form>
    </section>
  );
}
```

And without, over the SDK's `AgentClient`:

```ts
// Without React: the Agents SDK's AgentClient, and Motoko's client over it.
import { AgentClient } from "agents/client";

import { motokoClient, webSocketTransport } from "@chia1104/motoko-client";
import type { MotokoSessionState } from "@chia1104/motoko-client";

declare function render(state: MotokoSessionState): void;

const agent = new AgentClient({ agent: "notes", name: "ada", host: location.host });
// One client per socket: every caller of motokoClient(webSocketTransport(agent)) shares it.
const motoko = motokoClient(webSocketTransport(agent));

const { id } = await motoko.createSession();
const unfollow = motoko.follow(id, render);
await motoko.submit(id, { text: "Note that the milk is out.", requestId: crypto.randomUUID() });
// …and once the page is done with the session:
unfollow();
```

(`examples/browser/`, typechecked with the DOM's globals by its own `tsconfig.json`.)

## API

```ts
new MotokoCapability<Ports>({
  agent,                                     // the one agent definition the object runs
  models | modelsFor,                        // createAgentRuntime's: exactly one
  ports | portsFor,                          // createAgentRuntime's: exactly one
  closeIdleAfterMs?, defaultModel?, onReport?, settings?, deliverReply?,  // createAgentRuntime's
  store?,                                    // an AgentStore; default durableObjectStore(object's storage, scope)
  connections?,                              // MotokoConnections: the Agent itself, or a plain object's WebSockets
  authorize?,                                // (connection, call: MotokoCall) => boolean | Promise<boolean>
})
capability.instance(): Promise<AgentInstance>  // waits for the object's startup; core's AgentInstance
capability.scope: StorageScope                 // { kind: agent.kind, name: <the object's name> }
capability.host: AgentHost                     // the store, with wake: { kind: "alarm", arm }
capability.dispose(): Promise<void>            // the Lifecycle's teardown: closes the runtime, keeps the data
durableObjectStore(storage, scope, { prefix? }): AgentStore
type MotokoConnections = { getConnections(): Iterable<Connection> }
  & ({ isConnectionReadonly(connection): boolean } | { isReadonly(connection): boolean })  // Agent's | WebSockets'
type MotokoCall = { method: "subscribe", params: { sessionId, from? } } | { method: "submit", params: ... } | ...
MAX_SUBSCRIPTIONS                              // 8: the sessions one connection may follow
```

The options are `createAgentRuntime`'s for one agent, typed by `@chia1104/motoko-core`
(`AgentRuntimeModelsOption`, `AgentRuntimePortsOption`), so `modelsFor(scope)` and
`portsFor({ scope, sessionId, ... })` work as there, with this object's scope. `instance()` resolves to
core's `AgentInstance`: `createSession`, `listSessions`, `session(id)` with `submit`, `events`,
`approve`, `reply`, `abort`, `configure` and `delete`, as `@chia1104/motoko-core`'s README describes them.

Install it on an `Agent` in the constructor, after `super()`: `this.lifecycle.use(this.motoko)`, with
`connections: this`. On a plain Durable Object, declare it before the `lifecycle` field, with the
`WebSockets` capability as its connections:

```ts
readonly webSockets = new WebSockets({ handlers: { onMessage: (connection, message) => { /* the app's */ } } });
readonly motoko = new MotokoCapability({ agent, models, ports, connections: this.webSockets });
readonly lifecycle = Lifecycle.install(this).use(this.motoko).use(this.webSockets);
```

`instance()` waits for the Lifecycle's startup itself, so it may be called from an RPC method of
either.

Its capability id is `motoko` and its job `motoko-wake`, in the SDK's `cf_agents_jobs` table; neither
changes, so a pending wake-up outlives a deploy.

The client and the hook are [`@chia1104/motoko-client`](../client)'s:
`motokoClient(webSocketTransport(socket))` over the SDK's socket, and
`useMotokoSession(client, sessionId)`. Its README lists their API, and how the socket transport
queues calls, fails the ones a close cut off, and follows again on every `open`.

## The socket protocol

The socket carries Motoko's call protocol, the calls and errors of
[`@chia1104/motoko-wire`](../wire#the-call-protocol): `createSession`, `listSessions`, `submit`,
`approve`, `reply`, `abort`, `withdraw` and `deleteSession`, with their params, results and error codes, run on the
instance by `@chia1104/motoko-core`'s `runCall`. What the socket adds is its framing, and the two calls
and one error that exist because one socket follows several sessions.

Every frame is a JSON text frame whose `type` starts with `motoko:`, defined once with zod in
[`@chia1104/motoko-wire/socket`](../wire#the-socket-protocol), which the server and
`@chia1104/motoko-client`'s `webSocketTransport` both import. The client sends calls; the server
answers each, and streams the events of the sessions the connection follows.

| Frame           | Direction       | Fields                                                    |
| --------------- | --------------- | --------------------------------------------------------- |
| `motoko:call`   | client → server | `id`, `method`, `params`                                  |
| `motoko:result` | server → client | `id`, `result`                                            |
| `motoko:error`  | server → client | `id`, `error: { code, message }`                          |
| `motoko:event`  | server → client | `sessionId`, `cursor`, `event` (an `AgentWireEvent`)      |
| `motoko:ended`  | server → client | `sessionId`, `error: { code, message }`: the follow ended |

`method` is any of wire's calls, or one of the socket's own:

| `method`      | `params`                        | `result` |
| ------------- | ------------------------------- | -------- |
| `subscribe`   | `sessionId`, `from?` (a cursor) | `null`   |
| `unsubscribe` | `sessionId`                     | `null`   |

`code` is any of wire's codes, or the socket's own:

| `code`                   | When                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `too_many_subscriptions` | The connection follows `MAX_SUBSCRIPTIONS` sessions already. |

`invalid_request` also answers a frame of Motoko's that does not parse, and `internal` is emitted as
`motoko:socket_error`. A readonly connection is a readonly caller (see Authorization).

### Following

`subscribe` starts a reader of `session.events({ from })` for the connection, replacing an earlier
one of the same session. Its result comes before the reader's first event, and the client drops that
session's events until it arrives, so a follow started again on the same socket never mixes with the
one it replaced. Each event goes out as `motoko:event` with its cursor. A follow ends with
`motoko:ended` when its session is deleted or cannot be read.

Across reconnects the client's cursor is the one that counts. A new connection follows nothing, so on
every `open` the client subscribes again from the cursor of the last event it folded, and gets what
core's stream gives for it: exactly the events after it while the object instance still holds that
place in its log (a reconnect during the run), or else the events committed after it and the current
in-flight state, which fold into the same view.

Across hibernation the server's copy counts. After every event it sends, the capability writes the
session's cursor into the connection's state, which rides the socket's hibernation attachment. When
the object wakes (for a message, an RPC call or its alarm) the capability's `onStart` reads every open
connection's state and follows each session on from its cursor, so a socket that stayed connected
hears what happens next with no gap and no duplicate, and without asking. An object cannot hibernate
while a run works; a reset (a crash, a deploy) closes its sockets, and the client reconnects.

A connection follows at most `MAX_SUBSCRIPTIONS` (8) sessions, which keeps its state well inside the
attachment's 2 KiB. A reader keeps the instance open, so with `closeIdleAfterMs` it closes once no
socket follows a session.

### Beside the app's frames

The Lifecycle offers each socket message to every capability before the `WebSockets` catch-all.
`MotokoCapability` claims a frame only when its `type` starts with `motoko:` and it came on an open
connection of `connections`; everything else (the SDK's `cf_agent_*` and `rpc` frames, the app's own)
goes on to `WebSockets` and the app's `onMessage`, which never sees Motoko's. So the app installs the
capability and writes no glue, on an `Agent` and on a plain Durable Object alike. A socket of the
experimental `capnweb` transport carries its frames through Cap'n Web, not as socket messages, and is
not served.

In the browser every `message` listener sees every frame: the app's own (`useAgent`'s `onMessage`)
sees Motoko's too, and skips a `type` that starts with `motoko:`.

Motoko keeps what a connection follows under the `motoko` key of its state, beside the app's keys. An
app that sets connection state too updates it with a function that keeps the other keys
(`connection.setState((state) => ({ ...state, mine }))`). State of the app's that is not an object is
left alone; its connection's follows then last only as long as the object's instance in memory.

## Authorization

Two gates, both the app's. Who reaches which object is decided before the request gets there, as the
Usage example does with `routeAgentRequest`'s `onBeforeConnect` (and `onBeforeRequest` for HTTP): each
user reaches the object named after them alone. A Worker that routes requests itself checks the same
before `getByName(...).fetch(request)`. Browsers cannot set headers on a WebSocket upgrade, so the
sign-in travels in a cookie or in `useAgent`'s `query`.

Each call on a connection that got through is decided by `authorize`, when the app passes one. It runs
before every call, after its params parse, with the connection and the call as `{ method, params }`
(`MotokoCall`, typed from the protocol's schemas). `false` answers the call `forbidden` and runs
nothing; a throw is reported as a `motoko:socket_error` and answered `internal`. It may be async: the
reply still goes out when the call has run, and `subscribe`'s still before its first event. Without
`authorize`, every connection may make every call on its instance's sessions, and an object serves one
instance.

A connection the SDK marks readonly only follows: `subscribe`, `unsubscribe` and `listSessions` run,
and `createSession`, `submit`, `approve`, `reply`, `abort`, `withdraw` and `deleteSession` are answered `forbidden` before
`authorize` is asked. Motoko reads the mark off `connections`: an `Agent`'s `isConnectionReadonly`
(set with `shouldConnectionBeReadonly` or `setConnectionReadonly`), or the `WebSockets` capability's
`isReadonly` (its `readonly` option or `setReadonly`), so `connections: this` and
`connections: this.webSockets` need nothing more.

An object shared by several users would need checks per session: `authorize` sees each call's
`sessionId`, and which sessions a connection's user may touch is the app's to keep. Simpler still, give
each principal an object of its own.

## Asks between objects

A deferred tool's call in one object can ask another object's agent (core's
[Deferred tools](../core#deferred-tools)). The two objects reach each other over RPC, with two methods
of the app's on its object class: `ask`, which submits with the caller's reply address, and `reply`,
which hands a reply to the instance. `deliverReply` is the asked object's way back to the asker:

```ts
export class NotesAgent extends Agent<Env> {
  readonly motoko = new MotokoCapability<NotesPorts>({
    // ...the options of the Usage example, and the way back to the object that asked:
    deliverReply: async ({ to, text, isError }) => {
      const reply = { toolCallId: to.toolCallId, token: to.token, text, isError };
      await this.env.NOTES.getByName(to.scope.name).reply(to.sessionId, reply);
    },
  });

  /** Another object's call asks this agent: the run's answer goes to `replyTo` when the run ends. */
  async ask(sessionId: string, text: string, requestId: string, replyTo: ReplyAddress): Promise<string> {
    return (await (await this.motoko.instance()).session(sessionId).submit({ text, requestId, replyTo })).submissionId;
  }

  /** The asked object's reply. One refused for good resolves, so the asked object stops trying. */
  async reply(sessionId: string, input: ReplyInput): Promise<string> {
    try {
      return (await (await this.motoko.instance()).session(sessionId).reply(input)).outcome;
    } catch (error) {
      if (error instanceof ReplyNotPendingError || error instanceof SessionNotFoundError) return "refused";
      throw error;
    }
  }
}
```

The asking tool's `start` calls `env.NOTES.getByName(user).ask(sessionId, question, requestId, replyTo)`
with its context's `requestId` and `replyTo`. The asking object maps the refusals itself, so the asked
object needs no error class to cross RPC: a rejection of `reply` means "try again later". A failed
delivery sleeps until its retry, so the asked object's alarm brings it back after an eviction, and
the asking object reopens for the reply as it does for any call. A browser may send `reply` over the
socket too, but only the work the call started holds its token; `authorize` can refuse it outright.

## The wake

In an evicted object pi-durable has no process to keep its timers in, so the runtime arms the host
with pi-durable's wake: `active` while some task can run or is running, and `at`, the earliest sleep.
The host keeps one Lifecycle job for it:

- `active`: the job is due now;
- asleep until `at`, nothing running: the job is due at `at`;
- nothing to do: the job is cancelled.

The runtime arms only `active` from before every call that can start work until the call is done,
also while other calls end, and arms what is due once no such call is under way, so a call that
started nothing leaves no job behind and no job is cancelled under a call starting work.

When the job runs it calls `instance.resume()`. That opens the instance if the object was evicted, and
opening carries on what the lost isolate left: pi-durable sends an interrupted model request again and
reruns a replay-safe tool call. It also runs the sleeps now due. While work runs, the job waits on it
past its own run, inside the alarm's work (`trackAlarmWork`, so the alarm's memory-limit breaker
counts it), and keeps the job a heartbeat, 30 seconds, out: an object evicted mid-run is restarted by
that alarm and carries the run on, with no call from anyone. A wait lasts at most ten minutes, since
an alarm may run fifteen; longer work is waited on by a fresh alarm. While the job runs or waits, an
arm only updates what it reads when it is done, so the job is never moved under itself. A run that
fails through the Lifecycle's retries (the instance cannot open) is tried again a heartbeat out,
doubling up to ten minutes, its count kept in the object's storage.

The capability never calls `ctx.storage.setAlarm()` and defines no `alarm()`: the Lifecycle owns the
object's one alarm and sets it from the job queue.

## The store

`durableObjectStore(storage, scope, { prefix })`, the default, is pi-durable's SQLite storage on the
object's own database (`openDurableObjectSqliteStorage`), its tables under `prefix` (`motoko_` by
default, never `_cf_`, which Durable Objects reserve), apart from the SDK's `cf_agents_*` and the
app's. It serves `scope` alone and refuses every other with a `TypeError`. Its lease is held in the
object's memory: the platform runs one instance of an object at a time, so the one writer it admits is
the only one.

Its `erase` runs `eraseConversations` of `@chia1104/motoko-core/sqlite` in one transaction on the
object's database. The object's SQL API refuses `PRAGMA secure_delete` and `PRAGMA wal_checkpoint`
(`SQLITE_AUTH`), so the erased rows are deleted but not overwritten: their bytes may stay in free pages
until SQLite reuses them, which the object can neither check nor change. The runtime erases deleted
sessions when the instance closes, and eviction closes nothing, so set `closeIdleAfterMs` to have them
erased while the object lives.

A `store` of the app's own takes the default's place; the object's alarm stays the wake-up.

## Testing

The package's tests run inside workerd, under `vp test`, with `@cloudflare/vitest-plugin` and the
objects of `test/worker.ts`: core's `registerSingleScopeHostConformance` against the capability's host,
pi-durable's `registerStorageConformance` against the default store, an `Agent` that takes a
submission over RPC and finishes the run on pi-ai's faux provider, runs and sleeps carried on by the
alarm alone after `abortAllDurableObjects()`, the SDK's scheduler and state working beside it, and an ask
from one object to another over RPC, whose failed delivery the asked object's alarm alone tries again
after both objects are reset.

`test/socket.test.ts` drives the socket protocol through `@chia1104/motoko-client`'s client over
`webSocketTransport`, on an `Agent` and on a plain Durable Object with `WebSockets`: a run's events
in order, a reconnect that gets exactly the events it missed, a decision on a parked approval and the
typed errors, a deferred call parked in an evicted object and resumed by a `reply` over the socket, a
deleted session's follow ending, the app's own frames reaching the app alone, and a
follow carried on after `evictDurableObject()` with the socket hibernated, woken by an RPC call and
by the socket's own call. `evictDurableObject()` waits for an object's work to drain, so it cannot
evict one mid-run; a reset mid-run closes the socket, and the client resumes from its cursor. The
client's own tests, against a fake socket and a fake transport, and the hook's, are in
`@chia1104/motoko-client`.
