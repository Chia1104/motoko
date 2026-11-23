# @chia1104/motoko-client

Motoko from the browser: one client over every transport. It follows sessions, folding each one's
wire events into a session view with [`@chia1104/motoko-wire`](../wire)'s `applyEvent`, resumes each
from its last cursor when its connection drops, and makes the calls an app needs. The same client,
and the same app code, runs over either transport:

- `webSocketTransport(socket)`: a WebSocket to a Durable Object that serves Motoko's socket protocol,
  [`@chia1104/motoko-cloudflare`](../cloudflare)'s `MotokoCapability`, over the Agents SDK's
  `AgentClient`, the socket `useAgent` returns, or any WebSocket.
- `httpTransport({ baseUrl })`: HTTP and server-sent events to a Node server that mounts
  [`@chia1104/motoko-node`](../node)'s `motokoHandler`.

It imports nothing but `@chia1104/motoko-wire` (and React, for `/react`): no server, Agents SDK, pi
or Node code. React `^19` is an optional peer, for the hook alone.

```bash
pnpm add @chia1104/motoko-client
```

## Usage

```ts
// Without React, over HTTP: a page beside a Node server that mounts motokoHandler at /motoko.
import { httpTransport, motokoClient } from "@chia1104/motoko-client";
import type { MotokoSessionState } from "@chia1104/motoko-client";

declare function render(state: MotokoSessionState): void;
/** The app's own sign-in: a short-lived token, refreshed as it expires. */
declare function accessToken(): Promise<string>;

const motoko = motokoClient(
  httpTransport({
    baseUrl: "/motoko",
    // Asked again for each request, a follow's reconnects too, so each carries a fresh token.
    headers: async () => ({ authorization: `Bearer ${await accessToken()}` }),
  }),
);

const { id } = await motoko.createSession();
const unfollow = motoko.follow(id, render);
await motoko.submit(id, { text: "Note that the milk is out.", requestId: crypto.randomUUID() });
// …and once the page is done with the session:
unfollow();
```

Over a socket to a Durable Object, only the transport changes:
`motokoClient(webSocketTransport(agent))`, with `agent` the Agents SDK's `AgentClient` or the socket
`useAgent` returns (see [`@chia1104/motoko-cloudflare`](../cloudflare#usage)).

With React, a component takes the client and does not care which transport it has:

```tsx
// With React: a session's view and its calls, the same over either transport. The app makes its client once.
import { useState } from "react";

import type { MotokoClient } from "@chia1104/motoko-client";
import { useMotokoSession } from "@chia1104/motoko-client/react";

export function Session({ client, sessionId }: { readonly client: MotokoClient; readonly sessionId: string }) {
  const { view, status, submit, decide } = useMotokoSession(client, sessionId);
  const [draft, setDraft] = useState("");

  return (
    <section>
      {status === "connecting" && <p>Connecting…</p>}
      {status === "ended" && <p>This session is gone.</p>}
      {view.items.map((item) => {
        if (item.kind === "user" || item.kind === "assistant") return <p key={item.messageId}>{item.text}</p>;
        if (item.kind !== "tool" || !view.pendingApprovals.includes(item.toolCallId)) return null;
        return (
          <p key={item.toolCallId}>
            {item.label}
            <button onClick={() => void decide([{ toolCallId: item.toolCallId, approved: true }])}>Allow</button>
            <button onClick={() => void decide([{ toolCallId: item.toolCallId, approved: false }])}>Deny</button>
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

(`examples/`, typechecked with the DOM's globals by their own `tsconfig.json`.)

## API

```ts
motokoClient(transport: MotokoTransport): MotokoClient  // one per transport, shared by every caller
webSocketTransport(socket: MotokoSocket): MotokoTransport  // one per socket
httpTransport({ baseUrl, fetch?, headers? }): MotokoTransport
interface MotokoSocket {                                 // AgentClient, useAgent's socket, or a WebSocket
  readyState: number; send(data: string): void;
  addEventListener(type: "open" | "close" | "message", listener: (event: Event) => void): void;
  removeEventListener(type: "open" | "close" | "message", listener: (event: Event) => void): void;
}
interface HttpTransportOptions {
  baseUrl: string;                                       // motokoHandler's basePath: "/motoko", or a full URL
  fetch?: (input: string, init: RequestInit) => Promise<Response>;  // default: the global fetch
  headers?: HttpHeaders | (() => HttpHeaders | Promise<HttpHeaders>);  // a function is asked for each request
}

client.follow(sessionId, listener: (state: MotokoSessionState) => void): () => void  // returns the unfollow
client.sessionState(sessionId): MotokoSessionState  // the same object until it changes
client.createSession({ requestId? }?): Promise<SessionInfo>  // { id, createdAt }; requestId: a fresh one by default
client.listSessions(): Promise<SessionInfo[]>       // oldest first
client.submit(sessionId, { text, requestId, whenBusy?, replyTo? }): Promise<{ submissionId }>  // whenBusy: queue · steer · reject
client.withdraw(sessionId, submissionId): Promise<{ outcome }>  // withdrawn · already_placed · settled
client.approve(sessionId, decisions: ApprovalDecision[]): Promise<ApprovalOutcome[]>
client.reply(sessionId, { toolCallId, token, text, isError? }): Promise<{ outcome }>  // applied · already_replied
client.abort(sessionId): Promise<void>
client.deleteSession(sessionId): Promise<void>
client.close(): void                                // pending calls reject; the follows stop
interface MotokoSessionState {
  view: AgentSessionView;                           // motoko-wire's, folded with applyEvent
  cursor?: Cursor;                                  // right after the last event folded
  status: "connecting" | "live" | "ended";          // the follow's; the run's is view.status
  error?: MotokoError;                              // why it ended
}
class MotokoError extends Error { code: MotokoErrorCode | "connection_closed" }

// @chia1104/motoko-client/react
useMotokoSession(client: MotokoClient, sessionId: string): MotokoSessionState & {
  submit(text, { requestId?, whenBusy? }?): Promise<{ submissionId }>  // requestId: a fresh one by default
  withdraw(submissionId): Promise<{ outcome }>     // an input waiting in view.queued
  decide(decisions: ApprovalDecision[]): Promise<ApprovalOutcome[]>
  abort(): Promise<void>
}
```

Every follower of a session shares one follow. Once the last one leaves, the client keeps the follow
and its state for five seconds, then stops it. A follower who comes back meanwhile, as a remounted
component or React's `StrictMode` does, picks the follow up where it is instead of replaying the
session from its start. A follow the server ended is not kept. A listener that throws is reported as
uncaught, as an `EventTarget`'s listener is, and the others still hear the state. Each result is
parsed with wire's `callSchemas`, so a call resolves with what its schema says or rejects. A call the
server refuses rejects with a `MotokoError` whose `code` is the call error's (`session_busy`,
`session_owned`, `reply_not_pending`, `forbidden` and the others of [the call protocol](../wire#the-call-protocol)).
A call whose reply cannot come rejects with `connection_closed`: it was sent but not answered, so it may or may not
have run, and `submit` or `createSession` with the same `requestId` again is safe, as is `reply` again. The client retries no
call itself: when to try again, and whether to, is the app's. `createSession` sends a fresh
`requestId` unless it is given one, so a forwarded call tried again never makes a second session; to
retry it from the app, pick the ID before the first call:

```ts
const requestId = crypto.randomUUID();
const create = () => motoko.createSession({ requestId });
const session = await create().catch((error: unknown) => {
  if (error instanceof MotokoError && error.code === "connection_closed") return create();
  throw error;
});
```

A request ID is all `createSession` takes: what a session runs with stays the server's to choose, so
no client can loosen the approval gate.

`submit` with `replyTo` makes the submission an ask, and `reply` answers a deferred call (see core's
[Deferred tools](../core#deferred-tools)). Both are for the app's server code, which delivers one instance's answer to
another: a browser has no reply address to give, nor a token to reply with.

`motokoClient` keeps one client per transport, and `webSocketTransport` one transport per socket, so
`motokoClient(webSocketTransport(agent))` in a component's render is the same client every time. An
`httpTransport` is a new one at each call: make it once, outside render.

## The client and its transports

The client owns what is the same whatever carries it: each followed session's view, folded from its
events in order; its cursor, the one right after the last event it folded; its status; and the calls,
with their parsed results and typed errors. A transport owns its wire format and its reconnects, and
does two things:

```ts
interface MotokoTransport {
  call<M extends CallMethod>(method: M, params: CallParams<M>, signal: AbortSignal): Promise<unknown>;
  follow(sessionId: string, from: () => Cursor | undefined, listener: FollowListener): () => void;
}
interface FollowListener {
  live(): void;                      // the follow is on, from from(); again after each drop
  event(item: StreamItem): void;     // { cursor, event }
  ended(error: MotokoError): void;   // the server stopped following; nothing more comes
  dropped(): void;                   // the connection dropped; the transport follows again from from()
}
```

`call` resolves with the result as the server answered it, which the client parses, or rejects with a
`MotokoError`; once `signal` aborts (the client closed), it rejects with `connection_closed` and is
not sent if it was not yet. `follow` asks `from()` for the client's cursor each time it connects, so a
reconnect resumes after the last event the client folded, not the last one the transport saw. `follow`
may throw only before it has told the listener anything: the client's `follow` then throws that error,
and the session's next follower starts it afresh. Once it has told the listener something, a follow it
cannot keep ends with `ended(error)`. Any other carrier (Electron IPC, a test double) is a transport of
the app's own.

### Over a WebSocket

`webSocketTransport` speaks Motoko's socket protocol, whose frames
[`@chia1104/motoko-wire/socket`](../wire#the-socket-protocol) defines and the Cloudflare README
describes: a call is a `motoko:call` frame answered by `motoko:result` or `motoko:error`, a follow is
a `subscribe` call, and the server streams `motoko:event` frames and a `motoko:ended`. Frames whose
`type` does not start with `motoko:` are the app's, and the transport leaves them alone.

A call made while the socket is closed is sent once it opens; one sent on a connection that closes
before its reply rejects with `connection_closed`. A new connection follows nothing, so on every
`open` each follow subscribes again, from the client's cursor. The transport drops a session's events
until the server confirms its subscribe, so a follow started again on the same socket never mixes
with the one it replaced. A follow the server ended is neither subscribed again nor unsubscribed.

### Over HTTP

`httpTransport` makes each call a `POST {baseUrl}/call` with a JSON `{ method, params }`, and answers
with its `{ result }` or rejects with its `{ error }`. An answer that is not the handler's (the app's
own refusal in `resolve`, a proxy's error page) rejects with `forbidden` for a 401 or 403, and with
`internal` otherwise.

A follow is a `GET {baseUrl}/sessions/:sessionId/events`, its server-sent events read through
`fetch`'s streaming body rather than `EventSource`, so it sends `headers` (an `Authorization` header,
say) as a call does. The transport reads the stream as the SSE spec does: lines that end in CRLF, LF
or CR, comments, `data` over several lines, and an `ended` event that ends the follow. It leaves `id`
and `retry` alone: the cursor is in each event's data, and the client keeps its own.

When the stream ends without `ended`, or the server cannot be reached, the transport follows again
after a backoff (half a second at first, doubling up to 30 seconds, with jitter), sending
`Last-Event-ID` with the client's cursor, so the server resumes after the last event the client
folded. A server that cannot serve the follow now is tried again the same way: a 408, a 429, or any
5xx, such as a proxy's 502 during a deploy or a 503 `lease_held` while the instance's home fails over.
Any other answer before the stream starts is the server's answer to the follow: a cursor it cannot
honour (400 `invalid_cursor`), a caller it does not let (401, 403), a session that is gone (404). The
follow ends with that error and is not tried again.

## Testing

`test/client.test.ts` tests the client against a fake transport: the fold, the status across a drop,
the cursor it hands the transport, shared follows, parsed results and typed errors, and `close`.
`test/web-socket.test.ts` tests `webSocketTransport` against a fake socket, and `test/react.test.ts`
renders the hook once with `react-dom/server`. `test/http.test.ts` runs `httpTransport` against a real
`motokoHandler` on Node's `http`, on a runtime with pi-ai's faux provider, offline: a run's events in
order, a stream the server cuts mid-run resumed from the client's cursor with exactly the events a
reader that stayed connected got, the headers reaching `resolve`, and refusals ending the follow
untried again. Its last tests feed the SSE reader a stream one byte at a time.
[`@chia1104/motoko-cloudflare`](../cloudflare)'s workerd tests run `webSocketTransport` against a real
Durable Object.
