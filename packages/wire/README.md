# @chia1104/motoko-wire

The client contract of Motoko: one domain-free event vocabulary (`AgentWireEvent`), its zod
schemas, the `Cursor` a client resumes a stream from, `applyEvent`, the pure reducer that folds
events into a session view, and the call protocol every transport carries to an instance. It
imports nothing but zod: no pi, no provider SDK, no Node, so a browser bundle can use it.

The server derives every event from committed conversation state. Live events, replayed history and
a resumed stream fold through the same reducer, so a client that attaches late, reconnects, or
follows a restarted process ends with the view a client connected all along has.

## Usage

```ts
import { applyEvent, emptySessionView, streamItemSchema } from "@chia1104/motoko-wire";
import type { AgentSessionView, Cursor } from "@chia1104/motoko-wire";

/** A client folding a session's stream, whatever the transport (SSE, WebSocket, Electron IPC). */
export class SessionClient {
  view: AgentSessionView = emptySessionView();
  /** The last position folded; hand it back to resume, in this process or after a restart. */
  cursor: Cursor | undefined;

  /** Feed every message the transport delivers. */
  receive(message: unknown): void {
    const item = streamItemSchema.parse(message);
    this.view = applyEvent(this.view, item.event);
    this.cursor = item.cursor;
  }

  /** The calls an operator should decide now. */
  pendingCalls() {
    return this.view.items.filter(
      (item) => item.kind === "tool" && this.view.pendingApprovals.includes(item.toolCallId),
    );
  }
}
```

(`examples/client.ts`, typechecked with the package.)

## Events

| Event                      | Fields                                                                            | Meaning                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `run:start`                |                                                                                   | The agent started working on an input, or carrying on a run (`continue`).                |
| `user`                     | `messageId`, `text`, `at?`, `steer?`                                              | A user message as stored; `steer: true` when it joined the run going on.                 |
| `assistant:start`          | `messageId`                                                                       | A reply began streaming, under a stream id.                                              |
| `assistant:delta`          | `messageId`, `channel` (`text`/`thinking`), `delta`                               | More of the streaming reply.                                                             |
| `assistant:end`            | `messageId`, `text`, `thinking?`, `stopReason`, `error?`, `usage?`, `at?`         | The reply as stored, under its entry id; replaces the streamed one.                      |
| `tool:draft`               | `toolCallId`, `toolName`                                                          | The streaming reply began a call.                                                        |
| `tool:start`               | `toolCallId`, `toolName`, `label`, `tier`, `args`                                 | The model called a tool (from the stored reply).                                         |
| `tool:update`              | `toolCallId`, `output?`, `details?`                                               | Progress of a running call; only changed fields.                                         |
| `tool:end`                 | `toolCallId`, `toolName`, `status` (`ok`/`error`/`aborted`), `error?`, `details?` | How the call ended.                                                                      |
| `approval:request`         | `toolCallId`, `toolName`, `tier`, `args`                                          | The call waits for a decision on `args`, the arguments it runs with.                     |
| `approval:resolved`        | `toolCallId`, `approved`, `comment?`                                              | The decision.                                                                            |
| `reply:wait`               | `toolCallId`, `until?`                                                            | A deferred call is parked until its reply comes, or its deadline `until` passes.         |
| `retry:wait` / `retry:end` | `error`, `at` /                                                                   | A model request failed and waits to be retried / the wait is over.                       |
| `compaction:start`         | `reason` (`manual`/`threshold`/`overflow`)                                        | A compaction is going on: older messages are being summarized.                           |
| `compaction:end`           | `error?`                                                                          | No compaction goes on any more; `error`: the newest one failed.                          |
| `session:compacted`        | `messageId`, `summary`, `at?`                                                     | A summary replaced older messages in what the model reads.                               |
| `queue`                    | `items: [{ submissionId, text, whenBusy }]`                                       | The inputs waiting for a run, all of them, whenever that changes.                        |
| `run:end`                  | `reason` (`done`/`aborted`/`error`/`interrupted`), `code?`, `error?`              | The run ended; `code` is the engine's reason.                                            |
| `stream:reset`             |                                                                                   | Transport-level: the cursor cannot be honoured; discard the view, a full replay follows. |

`StreamItem` is `{ cursor, event }`; `cursor` is the position right after `event`. A call's `tier` is
`UNKNOWN_TIER` (`"unknown"`) when it is not known: the agent has no such tool, or the view shows the
call before its `tool:start`.

### Steering and the queue

An input submitted while a run is going waits for it, as `submit`'s `whenBusy` says: `queue` (the
default) waits for the run's answer and then starts a run of its own; `steer` joins the run going on
once its current tool round has its results, so the model reads it before its next reply. A run
starts at an input and holds every input that joined it, each sent as a `user` event with
`steer: true`, under that run's `run:start` and `run:end`. A steer that comes after the run's last
tool round waits for the answer like a queued input, and starts the next run with the inputs waiting
with it.

While inputs wait, `queue` lists them in submission order, each with its `submissionId` and
`whenBusy` (`queue` or `steer`), and it is sent again, whole, whenever an input joins it or leaves
it: a run took it (its `user` event comes first), `withdraw` took it back, or an aborted run dropped
it. Its last list is the queue; `queue` with no items empties it. A stream resumed from a cursor
it cannot continue exactly states the queue first, as it is then, since inputs a client saw waiting
may have left it meanwhile.
A client that does not know `queue` skips it and folds every other event as before.

### Compactions

A compaction summarizes a session's older messages into what the model reads from then on; the thread
keeps them. One starts when the app asks (`compact`, `reason: "manual"`), when the context nears the
model's window (`threshold`), or when a request overflows it (`overflow`), and it may run while the
session is idle or alongside a run. `compaction:start` says one is going on, and is sent again when
another, of another `reason`, goes on instead. `compaction:end` says none goes on any more: after a
summary (whose `session:compacted` comes first when the session is idle, else at the run's next
boundary), or with the newest one's `error` when it failed, which pi-durable keeps until a later
compaction succeeds. A compaction that finds nothing to summarize sends no `session:compacted`, and
leaves an earlier failure standing. Both come from `pi.live`, so a stream that replays the session shows only the compaction state as it is now.

### Cursors

A cursor names a position in committed state, so it outlives the process that handed it out:

```text
<session>.<entry>.<run>[.<epoch>.<seq>]      e.g. 7.42.40.0b6c7a8e1f2d3c4b.17
```

- `entry`: the newest stored entry whose events the client has all folded (0 before the first).
- `run`: the run the client is in, by the entry that started it: its user message's, or the marker
  of the `continue` that started it; `*` for a run that started without one; `-` between runs.
- `epoch`, `seq`: where the event sits in the server's in-memory log of the current run, present on
  events of that log.

`encodeCursor` and `decodeCursor` convert between the string and a `CursorPosition`; clients treat
cursors as opaque. Resuming from a cursor whose log place the server still holds yields exactly the
events after it, no duplicates and no gaps. Any other cursor (after a restart, from another process
on the same storage, or once its run has left the log) yields the queue and the compaction state as
they are (a `queue` event, then `compaction:start` or `compaction:end`), the events of what was
committed after `entry`, then the current in-flight state (see below), then the live stream; no
`stream:reset`, no replay of the session. The resumed events need not be the ones a connected client got, but they fold
into the same view. Only a cursor naming an entry the session's storage does not hold gets
`stream:reset` and a full replay.

### The view

`AgentSessionView` holds `items` (user and assistant messages, tool calls with their status and
approval, compaction notes, notices for runs that did not finish), `pendingApprovals` (tool call
ids), `status` (`idle`, `running`, `awaiting_approval`), `retrying`, `queued`, the inputs
waiting for a run, absent while none waits, and `compaction`, `{ status: "running", reason }` while a
compaction goes on or `{ status: "failed", error }` after one failed, absent otherwise. A user message that steered its run has `steer: true`.
Every event that names an item upserts it.

A tool call's `args` are those the model wrote (`tool:start`) until its `approval:request`, whose `args`
replace them: the arguments the call runs with, which an app's hook may have rewritten before the gate.

A tool call's `status` is `drafting`, `running`, `awaiting_approval`, `awaiting_reply` or how it ended
(`ok`, `error`, `aborted`). `awaiting_reply` is a deferred call parked on its reply, from its
`reply:wait`, with the deadline as `replyBy`. Its `tool:update` puts it back to `running`, without
`replyBy`, once a reply or the deadline woke it, and its `tool:end` ends it. The run stays `running`
meanwhile: nothing waits for an operator.

A resumed stream sends in-flight state again rather than replaying it, and the reducer applies what
a client may already hold idempotently: a stored message or call it has, `approval:request` for a
call still waiting (and none for a call that ended or was decided), `reply:wait` for a call still
parked on its reply, `tool:update` only for a call still running, the reply streamed so far as
`assistant:start` and one delta, `retry:wait` or `retry:end`, `queue`, `compaction:start` or
`compaction:end`, and `run:end` only while the view shows a run.

### Following a delegate's child

A delegate's call runs a sub-agent in a child session of its own. From its start, the call's details
are `{ sessionId, agent }` (`delegateDetailsSchema`): the child session and the sub-agent's kind.
`delegateOf(item)` reads them off a tool item, and returns `undefined` for any other call. The call
stays `running` in the parent's view while the child works, so a UI follows the child as it follows
any session:

```ts
for (const item of view.items) {
  if (item.kind !== "tool") continue;
  const child = delegateOf(item);
  if (child !== undefined) follow(child.sessionId); // the sub-agent's own messages, calls and questions
}
```

A call the sub-agent's policy gates waits in the child session, and is decided there.

## The call protocol

A call is a client's request of one instance. `callSchemas` defines each call once with zod: what it
takes (`params`), what it answers (`result`), and whether it changes the instance's sessions
(`writes`). Every transport carries the same calls, as `@chia1104/motoko-cloudflare` does over a
WebSocket to a Durable Object, and `@chia1104/motoko-node` over HTTP, and
`@chia1104/motoko-client` makes them over either. A transport frames them in its own envelope and
adds what only it has, such as following several sessions on one socket.

| `method`        | `params`                                                       | `result`                    | `writes` |
| --------------- | -------------------------------------------------------------- | --------------------------- | -------- |
| `createSession` | `requestId?`                                                   | `{ id, createdAt }`         | yes      |
| `listSessions`  | `{}`                                                           | `[{ id, createdAt }]`       | no       |
| `submit`        | `sessionId`, `text`, `requestId`, `whenBusy?`, `replyTo?`      | `{ submissionId }`          | yes      |
| `continue`      | `sessionId`, `requestId`                                       | `{ submissionId }`          | yes      |
| `approve`       | `sessionId`, `decisions: [{ toolCallId, approved, comment? }]` | `[{ toolCallId, outcome }]` | yes      |
| `reply`         | `sessionId`, `toolCallId`, `token`, `text`, `isError?`         | `{ outcome }`               | yes      |
| `abort`         | `sessionId`                                                    | `null`                      | yes      |
| `compact`       | `sessionId`, `instructions?`                                   | `null`                      | yes      |
| `withdraw`      | `sessionId`, `submissionId`                                    | `{ outcome }`               | yes      |
| `deleteSession` | `sessionId`                                                    | `null`                      | yes      |

`submit`'s `whenBusy` is `queue` (default), `steer` or `reject` (see Steering and the queue), and
its `submissionId` is what `withdraw` takes back while the input waits. `withdraw`'s `outcome` is
`withdrawn`, `already_placed` when a run took the input first, or `settled` when it was answered,
withdrawn or dropped already, so it may be sent again. `abort` drops every input waiting too.
`compact` asks for a compaction, with `instructions` for what its summary should keep, and is answered
once it is admitted; the stream shows it go (see Compactions).

`continue` starts a run on the session's context as it is, without a new message: it carries on a run
that ended without an answer, such as one at its turn limit (`run:end` with `code: "turn_limit"`) or
one whose model request found no credentials (`code: "no_credentials"`, once the app holds the key
again), from where it stopped. Inputs the failed run left waiting join it, so its first `user` event
is theirs; otherwise it shows `run:start` and the model's reply, with no `user` event. It is refused
while a run is going (`session_busy`), and a context with nothing to answer ends its run at once
(`run:end` with `code: "nothing_to_answer"`). Its `requestId`, like `submit`'s, makes a retry return
the first continue.

`submit`'s `replyTo` makes the submission an ask: the asked instance delivers the answer of the run it
starts to that reply address (`replyAddressSchema`: `{ scope, sessionId, toolCallId, token }`), as a
`reply` call to the asker. An ask always queues: it takes no `whenBusy: "reject"` or `"steer"`, and it
cannot be withdrawn, since its asker waits for its answer. `reply` answers a deferred call with the
token of its address. Its
`outcome` is `applied`, or `already_replied` for a call that has its reply, so a delivery may be sent
again.

`CallParams<M>` is what a sender writes, `CallResult<M>` what a receiver reads, and `Call` a call with
its params parsed, `{ method, params }`, as the server runs it. A readonly caller may make only the
calls whose `writes` is false. `@chia1104/motoko-core`'s `runCall` runs a `Call` on an instance, and
its `callErrorOf` maps what the instance threw to a code.

A call that fails answers a `CallError`, `{ code, message }` (`callErrorSchema`):

| `code`                 | When                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`      | A call that does not parse, or core's `InvalidRequestError` (a refused `replyTo`, or a `withdraw` of an ask's input or of one the session does not hold). |
| `session_not_found`    | Core's `SessionNotFoundError`; also the end of a follow whose session was deleted.                                                                        |
| `session_busy`         | Core's `SessionBusyError`: `submit` with `whenBusy: "reject"`, or `continue`, while a run is going.                                                       |
| `session_owned`        | Core's `SessionOwnedError`: `submit`, `continue`, `withdraw`, `compact` or `deleteSession` of a child session.                                            |
| `approval_not_pending` | Core's `ApprovalNotPendingError`; no decision of the batch was applied.                                                                                   |
| `reply_not_pending`    | Core's `ReplyNotPendingError`: no such call waits for this reply, or its token is wrong.                                                                  |
| `invalid_cursor`       | A cursor of another session, or core's `InvalidCursorError`.                                                                                              |
| `instance_closed`      | Core's `InstanceClosedError`: the instance lost its lease or its storage failed.                                                                          |
| `lease_held`           | Core's `LeaseHeldError`: another writer holds the instance.                                                                                               |
| `forbidden`            | A readonly caller's call that writes, or one the app's `authorize` refused; nothing ran.                                                                  |
| `internal`             | Anything else; the message says nothing, and the server reports the error.                                                                                |

A client that follows a session gets each event as `{ sessionId, cursor, event }`
(`followedEventSchema`), and `{ sessionId, error }` (`followEndedSchema`) when the server stops
following it: the session was deleted, or it cannot be read. `sessionIdSchema` is the session id
every call and frame carries.

## The socket protocol

`@chia1104/motoko-wire/socket` holds the frames of the socket transport, the one module its server
(`@chia1104/motoko-cloudflare`'s `MotokoCapability`) and its client (`@chia1104/motoko-client`'s
`webSocketTransport`) both import. Each frame is a JSON text frame whose `type` starts with `motoko:`,
so it rides one socket beside the frames of the Agents SDK and of the app:

- `callFrameSchema`: the client's `motoko:call`, with an `id`, a `method` and its `params`;
- `serverFrameSchema`: the server's `motoko:result` and `motoko:error` for a call's `id`, and
  `motoko:event` and `motoko:ended` (`followedEventSchema` and `followEndedSchema`, with their `type`)
  for a session the connection follows;
- `motokoCalls`: `callSchemas` and the socket's own two calls, `subscribe` (`sessionId`, `from?`) and
  `unsubscribe` (`sessionId`), which exist because one socket follows several sessions;
- `motokoErrorCodeSchema`: the call error codes and the socket's own, `too_many_subscriptions`;
- `motokoFrame(message)`: a text frame of Motoko's as JSON, or `undefined` for the SDK's or the app's.

`MotokoMethod`, `MotokoParams<M>`, `MotokoResult<M>`, `MotokoCall` and `MotokoErrorCode` are their
types. The Cloudflare package's README describes how a follow runs over them.

## How the vocabulary was unified

The two source runtimes: chia1104.dev's `agent-runtime` (`wire/schema.ts`) and solyx's `@solyx/agent`
(`wire.ts`). The runtime keeps what any agent app needs and drops what belongs to one domain or to a
feature this milestone does not have.

| Source  | Event                                | Decision                                                                                                        | Why                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| both    | `run:start`                          | **kept**; chia's `sessionId` dropped                                                                            | A stream is already one session's.                                                                                                                                                                                                                                                      |
| both    | `user`                               | **kept**; `attachments` dropped                                                                                 | Both apps' attachment kinds are domain records (drafts, feeds, reports; files with paths).                                                                                                                                                                                              |
| both    | `assistant:start`, `assistant:delta` | **kept**                                                                                                        | Identical in both.                                                                                                                                                                                                                                                                      |
| both    | `assistant:end`                      | **kept**, `stopReason` made required, `error` added; usage **merged** (`costTotal` renamed `cost`)              | pi-durable stores failed replies as entries; the client shows why one failed.                                                                                                                                                                                                           |
| solyx   | `tool:draft`                         | **kept**                                                                                                        | Generic: a call shows while its arguments stream.                                                                                                                                                                                                                                       |
| both    | `tool:start`                         | **kept** in chia's shape (`label`, `tier`, `args`); solyx's `parentToolCallId` dropped                          | Nested calls (code mode) are not in this milestone. Emitted from the stored reply, so replay and live agree.                                                                                                                                                                            |
| chia    | `tool:update`                        | **kept**, `summary` **renamed** to `output` + `details`                                                         | chia's summary came from a per-kind summarize policy the runtime does not have; pi-durable publishes running output and details.                                                                                                                                                        |
| both    | `tool:end`                           | **merged**: chia's `isError` + `aborted` became solyx's `status`; chia's `summary` and solyx's `output` dropped | `status` is one field for three outcomes; `output` was specific to shell and code mode.                                                                                                                                                                                                 |
| both    | `approval:request`                   | **kept** in chia's shape                                                                                        | A client renders the call without looking it up. solyx sent only the id.                                                                                                                                                                                                                |
| both    | `approval:resolved`                  | **kept** in chia's shape; solyx's `auto` dropped                                                                | The runtime has no auto-approval mode yet.                                                                                                                                                                                                                                              |
| solyx   | `retry:wait`, `retry:end`            | **kept**, `at` added to `retry:wait`                                                                            | Generic, from `pi.live`.                                                                                                                                                                                                                                                                |
| both    | `session:compacted` / `compacted`    | **merged** under chia's name, with solyx's `messageId` and `at`; chia's `tokensBefore` dropped                  | pi-durable writes compaction entries on its own; the entry does not record a token count.                                                                                                                                                                                               |
| solyx   | `compaction:start`, `compaction:end` | **kept**, from `pi.live.compactions` and `compactionFailure`; `compaction:end` carries the failure's `error`    | A client shows a compaction going on, and why one failed (see Compactions).                                                                                                                                                                                                             |
| chia    | `session:rewound`                    | **dropped**                                                                                                     | Navigation and forks are not in the runtime.                                                                                                                                                                                                                                            |
| chia    | `state:changed`                      | **dropped**                                                                                                     | Synced agent state is out of scope.                                                                                                                                                                                                                                                     |
| chia    | `error`                              | **merged** into `run:end` (`reason: "error"`, `code`, `error`)                                                  | In pi-durable a failure ends the run; chia's classified `AgentErrorKind` is replaced by pi's own reason code.                                                                                                                                                                           |
| both    | `run:end`                            | **kept**, reasons unified to `done`, `aborted`, `error`, `interrupted`                                          | chia's `awaiting_approval` dropped: in pi-durable a run waiting for a decision is still running (its call is parked), so the view's `status` says it. solyx's `store-failed` dropped (a failed store closes the instance; streams end). `turn-limit` is `error` with code `turn_limit`. |
| solyx   | `context`                            | **dropped**                                                                                                     | Context budgets and usage ledgers are out of scope.                                                                                                                                                                                                                                     |
| solyx   | `named`                              | **dropped**                                                                                                     | Title generation is out of scope.                                                                                                                                                                                                                                                       |
| runtime | `stream:reset`                       | **added**                                                                                                       | A cursor storage cannot honour must be answered honestly (see Cursors).                                                                                                                                                                                                                 |
| runtime | `queue`, `user`'s `steer`            | **added**                                                                                                       | pi-durable queues an input a busy session gets, and places a steer into the run going on; a client shows what waits and takes it back (see Steering and the queue).                                                                                                                     |
