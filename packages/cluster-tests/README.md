# @chia1104/motoko-cluster-tests

Private. Two Motoko nodes in one process on one database, each with its own store, lease `holder`,
runtime, handler and HTTP server, as two machines would run them. `test/forwarding.test.ts` proves
[forwarding](../node#forwarding-experimental): a call or follow sent to the node that is not the
instance's home is forwarded there and authenticated again, a graceful and a crashed home hand the
instance over, a request is never forwarded twice, nor to a holder that is not a peer, and an ask
crosses the nodes: a deferred call's `submit` is forwarded to the asked home, and that home's
`reply` back to the asker's.

The tests run on PGlite (`@chia1104/motoko-store-postgres/pglite`), and on Postgres too when
`TEST_DATABASE_URL` is set. A crashed node is emulated in process: its store's statements fail from
then on, unsent, and its server closes, so its leases are neither renewed nor released.

They live in a package of their own because they need `@chia1104/motoko-node`,
`@chia1104/motoko-store-postgres` and `@chia1104/motoko-client` together. Node cannot dev-depend on
the store, which dev-depends on node, and none of the three should carry the others' tests.

`pnpm bench` (`bench/failover.ts`) measures the failover after a crash and the cost of a forward.
