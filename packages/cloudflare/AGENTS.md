# @chia1104/motoko-cloudflare

`MotokoCapability` runs Motoko inside a Cloudflare Durable Object as an Agents SDK capability. The object's SQLite is
the store, with an in-object lease; its alarm is the wake, as one Lifecycle job; and it serves the socket protocol on
the object's WebSockets.

- Tests run inside workerd through `@cloudflare/vitest-plugin`, on the objects in `test/worker.ts` configured by
  `test/wrangler.jsonc`. Files run one at a time, because `abortAllDurableObjects()` reaches every file's objects.
- `evictDurableObject()` waits for an object's work to drain, so it cannot evict mid-run. To cut a run off, reset the
  object; that closes the socket, and the client resumes from its cursor.
- `typecheck` also checks `examples/browser`.
- `examples/notes-agent.ts`, `examples/browser/notes-client.ts` and `examples/browser/notes-session.tsx` appear
  verbatim in the README (`test/readme.test.ts`).
