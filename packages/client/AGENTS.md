# @chia1104/motoko-client

The browser client. It follows sessions, folds their events with wire's `applyEvent`, resumes each from its cursor
after a drop, and makes the calls. One client runs over two transports: `webSocketTransport` (a Durable Object serving
the socket protocol) and `httpTransport` (a Node server's `motokoHandler`). `/react` adds a hook.

- It imports only `@chia1104/motoko-wire` and `@chia1104/motoko-wire/socket`, plus `react` in `src/react.ts` alone,
  and uses no Node global. React `^19` is an optional peer.
- The same app code runs over either transport, so a change to one transport's behaviour usually needs the other.
- Tests: `client.test.ts` uses a fake transport, `web-socket.test.ts` a fake socket (`test/fake-socket.ts`),
  `http.test.ts` a real `motokoHandler` on the faux provider, and `react.test.ts` renders with `react-dom/server`. The
  tests against a real Durable Object socket are in cloudflare's workerd suite.
- `examples/http.ts` and `examples/session.tsx` appear verbatim in the README (`test/readme.test.ts`).
