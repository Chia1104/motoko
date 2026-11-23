# @chia1104/motoko-cluster-tests

Private and unpublished: two Motoko nodes in one process on one database, testing node's forwarding end to end. The
README lists what the tests prove; node's README ("Forwarding (experimental)") is the spec.

- It is its own package because it needs node, store-postgres and client together, and node cannot dev-depend on the
  store, which dev-depends on node. Cross-node tests go here, not in those packages.
- It runs on PGlite, and on a real Postgres too when `TEST_DATABASE_URL` is set.
- A crashed node is emulated in process (`test/nodes.ts`): its store's statements fail unsent from then on and its
  server closes, so its leases are neither renewed nor released.
- `pnpm bench` (`bench/failover.ts`) measures the failover after a crash and the cost of a forward.
