# @chia1104/motoko-wire

The contract between a Motoko server and its clients: the wire events and their zod schemas, cursors, the
`applyEvent` reducer, the call protocol, and the socket protocol's frames (`/socket`).

- It imports only `zod` and its own modules, so a browser bundle can take it.
- `applyEvent` is pure. Live events, replayed history and a resumed stream fold through it to the same view, so an
  event must give the same result whichever way it arrives.
- Every side speaks this contract: core's transcriber (`core/src/engine/transcriber.ts`) produces the events, node
  serves the calls over HTTP, cloudflare serves the calls and socket frames, and client consumes all of them. A change
  here updates those packages and their tests in the same change.
- `examples/client.ts` appears verbatim in the README.
