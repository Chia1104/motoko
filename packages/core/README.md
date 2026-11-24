# @chia1104/motoko-core

The Motoko runtime on pi-durable: agent definitions, the host contract, and `createAgentRuntime`, which runs
named agent instances. It uses no Node built-ins, so it can run in a Node process, Electron or a
Durable Object; the long-lived Node host is `@chia1104/motoko-node`.

pi is a peer dependency: install `@earendil-works/pi-durable`, `pi-ai`, `chord` and `pi-schema` at
`~1.6.0` beside the runtime, and import models, providers and storages from them.

## Usage

The host here is written out to show the contract; `@chia1104/motoko-node` ships one with SQLite.

```ts
// pi is the app's own dependency: its models, providers and storages come from it directly.
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { MemoryStorage } from "@earendil-works/pi-durable";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool, inProcessLeases } from "@chia1104/motoko-core";
import type { AgentHost, ToolContext } from "@chia1104/motoko-core";

// ─── Definitions: no ports, no credentials; a client may import them. ─────────

interface NotesPorts {
  readonly notes: Map<string, string>;
}

const readNote = defineTool({
  name: "read_note",
  description: "Read a note by its key",
  label: "Read note",
  tier: "read",
  replay: "safe", // reading twice after a crash duplicates nothing
  parameters: z.object({ key: z.string(), maxChars: z.number().int().optional() }),
  async execute({ key, maxChars }, { ports }: ToolContext<NotesPorts>) {
    const text = ports.notes.get(key) ?? "";
    return { text: text.slice(0, maxChars ?? text.length), details: { key, found: ports.notes.has(key) } };
  },
});

const deleteNote = defineTool({
  name: "delete_note",
  description: "Delete a note",
  tier: "write",
  parameters: z.object({ key: z.string() }),
  async execute({ key }, { ports }: ToolContext<NotesPorts>) {
    ports.notes.delete(key);
    return { text: `Deleted ${key}.` };
  },
});

export const notesAgent = defineAgent<NotesPorts>({
  kind: "notes",
  instructions: "You manage the user's notes. Ask before deleting anything.",
  tools: [readNote, deleteNote],
  policy: { requiresApproval: ["write"] }, // write-tier calls wait for an operator
  model: { provider: "anthropic", modelId: "claude-sonnet-5" },
});

// ─── A host: storage, a single writer, wake-ups. ──────────────────────────────

const host: AgentHost = {
  wake: { kind: "process" }, // a long-lived process: pi-durable's own timers wake sleeping work
  lease: inProcessLeases(), // one writer per scope within this process
  async storage() {
    return new MemoryStorage();
  },
};

// ─── The runtime: definitions bound to a host, models and ports. ────────────────

const models = createModels();
models.setProvider(anthropicProvider()); // reads ANTHROPIC_API_KEY

const runtime = createAgentRuntime({ agents: [notesAgent], host, models, ports: { notes: new Map() } });

const alice = runtime.get(notesAgent, "alice"); // one named instance: one Harness over its storage
const { id } = await alice.createSession();
const session = alice.session(id);

await session.submit({ text: "Delete my shopping note", requestId: crypto.randomUUID() });

for await (const { cursor, event } of session.events()) {
  // `cursor` is where a reconnecting client resumes: session.events({ from: cursor })
  if (event.type === "approval:request") {
    await session.approve([{ toolCallId: event.toolCallId, approved: false, comment: "Keep it for now." }]);
  }
  if (event.type === "run:end") {
    console.log("run ended:", event.reason, "at", cursor);
    break;
  }
}

await runtime.close();
```

(`examples/notes-agent.ts`, typechecked with the package.)

## Definitions

- `defineTool({ name, description, label?, tier, replay?, executionMode?, parameters, execute })`:
  zod `parameters`; `execute(args, context)` gets the arguments parsed with them and a
  `ToolContext` (`ports`, `signal`, `scope`, `sessionId`, `toolCallId`, `output()`, `update()`), and
  returns `{ text, details? }`: the text the model reads and JSON for clients. `replay` and
  `executionMode` are pi-durable's, passed through: `replay: "safe"` lets a call a crash cut off run
  again on reopen; the default `unsafe` tells the model it was interrupted. The zod schema is
  converted once to the JSON Schema pi validates and coerces against; an optional parameter is
  offered to the model as nullable and a `null` it sends is dropped before validation, as chia's
  `pi/tools.ts` does.
- `defineDelegate({ name, description, label?, tier, executionMode?, agent })`: a tool whose call runs
  the sub-agent `agent` in a child session and returns its answer (see [Delegates](#delegates)). It
  takes `{ task: string }` and is `replay: "safe"`.
- `defineDeferredTool({ name, description, label?, tier, executionMode?, parameters, timeoutMs?, start,
  cancel? })`: a tool whose call starts work elsewhere with `start`, then parks until a reply reaches
  it or `timeoutMs` (default 24 hours) passes, and returns the reply (see
  [Deferred tools](#deferred-tools)). It is `replay: "safe"`.

A tool is one of three kinds, by `kind`: `app` (what `defineTool` returns, run by its own `execute`),
`delegate` and `deferred` (run by the runtime). All three carry `name`, `description`, `label` and
`tier`, so the approval gate, a session's tool selection and its approval rule treat them alike.

- `defineAgent({ kind, instructions, tools, policy?, model? })`: no ports or credentials, so a client
  or a capability listing can import it. `policy.requiresApproval` is a list of tiers or a function
  of `(tier, toolName)`. `model` is a pi-durable `ModelRef` (`{ provider, modelId }`), never a key.
  The kind is held to the scope rule below.

## The host contract

```ts
interface StorageScope { kind: string; name: string }                       // one agent instance
interface Lease {
  readonly signal: AbortSignal;                    // aborts if the lease is lost
  release(wake?: Wake): Promise<void>;             // `wake`: what the instance left (pi-durable's harness.wake())
}
interface AgentStore {                             // what a database supplies per instance
  lease(scope: StorageScope): Promise<Lease>;      // rejects with LeaseHeldError while another writer holds it
  storage(scope: StorageScope, lease: Lease): Promise<Storage>;  // pi-durable Storage, opened under that lease
  unfinished?(): AsyncIterable<StorageScope>;      // optional: scopes that may have work, for runtime.recover()
  erase?(scope, lease, conversations): Promise<void>;  // optional: erase deleted sessions, storage closed
}
interface AgentHost extends AgentStore {           // what the runtime takes: a store plus wake-ups
  readonly wake: HostWake;
}
type HostWake =
  | { kind: "process" }                                                    // pi-durable's own timers
  | { kind: "alarm"; arm(scope: StorageScope, wake: Wake): Promise<void> }; // evictable host; pi-durable's Wake
assertScope(scope): void    // the one definition of a valid scope, for every host and storage
scopeKey(scope): string     // a stable string for maps and lease tables
inProcessLeases(): (scope) => Promise<Lease>  // a lease table of its own, held in this process's memory
```

`assertScope` accepts a scope whose `kind` and `name` are strings of 1 to 1024 characters (Unicode
code points), well-formed Unicode (`isWellFormed()`: no lone surrogates), with no NUL character, and
throws a `TypeError` naming the part that is not. The runtime checks every instance it makes; a host or
storage that keys anything by scope calls it too.

A database supplies the store: its lease and its storage, always as one pair, because a storage may
fence its commits with the lease its own `lease()` made. The environment adds the wake-ups that make
the store a host, such as `nodeHost(store)` of `@chia1104/motoko-node` in a long-lived process. The
store's methods may take a narrower lease than `Lease`, since the runtime hands `storage` and `erase`
the lease that the same store's `lease()` returned.

pi-durable keeps durability in the storage, so this is all a host supplies. Opening an instance
takes the lease, opens the storage, opens one Harness, attaches to the sessions that have unfinished
work and calls `harness.resume()`. A lost lease closes the instance at once. With an `alarm` host
the runtime passes pi-durable's `onWake` to `arm`. From before every call that can start work
(`submit`, `approve`, `abort`, `resume`, `delete`) until the call is done, it arms only
`{ active: true }`, whatever other calls and runs report meanwhile, since pi-durable reports a call's
work only after the commit that starts it. Once no such call is under way it arms `harness.wake()`
(pi-durable reports only changes, and a call that started nothing changes nothing). The host calls
`instance.resume()` when its alarm fires. `@chia1104/motoko-cloudflare` is such a host: a Durable
Object's.

Two capabilities are optional. `unfinished()` lists the scopes whose storage may hold work that needs
a process: a task that can run or was running, or a sleep. It must never list fewer than those; it may
list more, at the cost of opening them. A host learns what an instance left from `release(wake)`, which
the runtime calls with `harness.wake()` as it closes the instance, and a scope whose lease was never
released (its process crashed) counts too. `erase(scope, lease, conversations)` erases deleted
sessions: each conversation with its entries, tasks, submissions and documents, and the conversations
its tasks made. The runtime calls it with the lease held and the storage closed; the host skips a
conversation that still has unfinished work or that another conversation forks from, and the runtime
asks again at the instance's next close.

`inProcessLeases()` admits one writer per scope among the hosts given the same function, and sees
no other process. It is the lease of a host that runs in one process, such as `@chia1104/motoko-node`'s
default.

### Checking a host

`@chia1104/motoko-core/testing` holds the contract as a suite every host runs against itself. It takes the
host's own test runner, as pi-durable's `registerStorageConformance` does, so the core depends on no
test framework:

```ts
import { registerHostConformance } from "@chia1104/motoko-core/testing";
import { describe, expect, it } from "vitest";

registerHostConformance({ describe, expect, it }, "my host", async (use) => {
  const host = myHost(); // fresh resources for each case, cleaned up after it
  await use(host);
});
```

Each case runs on scopes of its own, so one host may serve every case. The suite checks that a held
scope refuses a second `lease()` with `LeaseHeldError` and that `release()` frees it; that a second
`release()` after another holder took the scope frees nothing; that scopes differing only in where a
`/` falls hold separate leases and storages; that an invalid scope is rejected with a `TypeError`;
that `storage(scope, lease)` opens a pi-durable `Storage` that commits and reads back, while the
lease's `signal` stays unaborted; and that `release(wake)` frees the scope. For a host that has them,
it checks that `unfinished()` lists a scope released with work that can run or with a sleep, and that
`erase()` removes a session the runtime deleted and keeps the others. What one host adds (expiry,
other processes, fencing) stays in its own tests.

A host that serves one scope alone, as a Durable Object's serves the object's own, runs
`registerSingleScopeHostConformance` instead. Its provider makes a fresh host for each case and names
the scope it serves, `use(host, scope)`; the cases run on that scope, and in place of keeping two
scopes apart the host must refuse every other scope with a `TypeError`.

### Shared-database stores

`@chia1104/motoko-core/store` is what every store that keeps many scopes in one database has in
common, whatever its SQL dialect: a row lease per scope with a fencing token and an expiry by the
database clock, renewed for all of a store's leases in one statement per interval; and a commit that
reads the check state once, runs pi-durable's batch checks in memory, and writes the accepted
batches' net effect once, atomically, only if a guard holds (the lease token current and unexpired,
`next_seq` unchanged). `createSharedStore(dialect, options)` makes the store from a `StoreDialect`,
the statements of the store and its lease, and a dialect's storage commits with `commitBatches`
through a `CommitPort`: read the check state, write a plan if the guard holds and say why it refused,
read a copy's source. A plan claims only the IDs no stored record claims yet, so a commit that only
rewrites a task claims nothing. A `StorageShell` is the rest of a dialect's storage that is not SQL:
it admits calls until `close()` and drains them, mints IDs in memory, runs the commit, retries a
read after a transient connection failure, and keeps the content `findDocument` read for the
`document()` call that follows (`DocumentRows`, `materializeDocument`). The dialect owns its
storage's reads, its schema and its migrations. `@chia1104/motoko-store-postgres` and
`@chia1104/motoko-store-mysql` are such stores.

`registerStoreConformance(runner, name, provider)` of `@chia1104/motoko-core/store/testing` is the
suite such a store runs against itself, on the runner shape of `registerHostConformance`. The
provider hands each case a target: the store, and what only the dialect can do to its database
(expire a lease now, delete a scope's row behind its holders, cut a connection, run something
between a commit's read and its write, count a scope's rows). It checks that a writer that lost
its lease writes nothing, that a lease expires and is taken over, that a release records the wake
`unfinished()` lists, that scopes in one database are apart, the rules of `erase()` and
`deleteScope()`, and that two storages under one lease cannot both commit. A target without
`otherProcess` (a database of one connection) passes the case that needs another process without
running it.

## The runtime

```ts
createAgentRuntime({
  agents, host, defaultModel?, onReport?,
  models | modelsFor,      // exactly one: one Models for every instance, or one per instance
  ports | portsFor,        // exactly one: one ports object, or ports per tool call
  closeIdleAfterMs?,       // close an instance idle this long; default never
  settings?,               // pi-durable's settings; the runtime sets `extensions`
  extensionsFor?,          // (scope) => AppExtension[]: the app's pi-durable extensions for an instance; default none
  telemetryFor?,           // (scope) => TelemetryContext: an instance's pi-telemetry; default pi's, which records nothing
  envFor?,                 // (scope) => pi-durable's env: builds an instance's ExecutionEnv; default none
  deliverReply?,           // (reply, signal) => Promise<void>: how an ask's answer reaches its asker
}): AgentRuntime
runtime.get(agent, name): AgentInstance       // lazily opened, one per scope per runtime
runtime.recover({ concurrency? })             // open the scopes the host lists as unfinished
runtime.inspect(): AgentRuntimeInspection     // what the runtime holds: { open, instances }
runtime.close()
instance.state                                // dormant · opening · open · closing · closed · lease_lost · failed
instance.open() · createSession({ model?, thinkingLevel?, maxTurns?, tools?, requiresApproval?, requestId? })
instance.listSessions() · session(id)
instance.resume() · refreshModels() · close()
session.submit({ text, requestId, whenBusy?, replyTo? })  // idempotent on requestId; replyTo makes an ask
session.continue({ requestId })                 // carries on a run that ended without an answer; idempotent
session.withdraw(submissionId)                  // { outcome: "withdrawn" | "already_placed" | "settled" }
session.events({ from?, signal? })              // AsyncIterable<{ cursor, event }>
session.approve([{ toolCallId, approved, comment? }])  // one commit: all of the batch, or none
session.reply({ toolCallId, token, text, isError? })  // { outcome: "applied" | "already_replied" }
session.abort()
session.compact({ instructions? })              // resolves once admitted; the stream shows it go
session.configure({ model?, thinkingLevel?, maxTurns?, tools?, requiresApproval? })  // one commit; null puts back the agent's
session.settings()                              // { model, thinkingLevel, maxTurns?, tools, requiresApproval? }
session.delete()                                // with its child sessions
```

A session is a pi-durable conversation. An input to a busy session waits, as `whenBusy` says:
`queue` (the default, pi-durable's follow-up) waits for the run's answer and starts the next run;
`steer` joins the run going on at the end of its current tool round, so the model reads it before
its next reply; `reject` throws `SessionBusyError` instead. With no run going, each starts a run.
Its stream lists what waits as `queue` events and marks a steer's `user` event (see
[wire](../wire#steering-and-the-queue)). `withdraw` takes back an input still waiting, by the
`submissionId` its `submit` gave; it rejects with `InvalidRequestError` for a submission the
session does not hold, or an ask's. `abort` drops every input waiting, as pi-durable's abort does.
A steer is stored as a `motoko.steer` entry rather than `pi.user`, whichever run it lands in, so the
stream can tell an input that joined a run from one a failed run handed to the next.
pi-durable's `steeringMode` and `followUpMode` (in `settings`) say whether a boundary takes the first
waiting steer or follow-up, or all of them. `models` is pi-durable's
`HarnessOptions["models"]` (a `Models`, or a function returning the current one), passed as is.
The static and the resolved forms are told apart by their option's name, never by `typeof`: a
`ports` object may itself be callable, and `models` may be pi's function.

`onReport` receives an `InstanceReport` for failures that fail no call of the app's:

```ts
type InstanceReport =
  | { source: "pi"; scope: StorageScope; report: Report }   // pi-durable's Report, every field as pi gave it
  | { source: "runtime"; scope: StorageScope; error: unknown;
      kind: "listener_error" | "close_failed" | "lease_release_failed" | "arm_failed" | "models_failed"
        | "reopen_failed" | "erase_failed" }
  | { source: "runtime"; scope: StorageScope; error: unknown;
      kind: "ports_failed"; sessionId: string; toolCallId: string; toolName: string }
  | { source: "runtime"; scope: StorageScope; error: unknown;
      kind: "reply_failed"; sessionId: string; requestId: string;
      to: { scope, sessionId, toolCallId };  // the reply address, without its token
      attempt: number; gaveUp: boolean };
```

`reply_failed` is an ask whose reply `deliverReply` failed to deliver: it is tried again unless
`gaveUp`. It is also reported, with `gaveUp` and `attempt: 0`, for an ask whose request was first
submitted without a reply address, whose run's answer therefore reaches no one.

`telemetryFor(scope)` gives an instance its pi-telemetry `TelemetryContext`, which the runtime hands
to pi-durable's `HarnessOptions.telemetry` each time the instance opens. It then receives pi-durable's
content-free spans and metrics (`pi.durable.submit`, `pi.durable.phase`, ...) for that instance alone,
so an app can tag them with the scope or send each caller's to its own exporter. A throw fails the
open. The app imports pi-telemetry itself; core depends on none of it.

`envFor(scope)` gives an instance its execution environment: pi-durable's `HarnessOptions.env`, a
function that builds the `ExecutionEnv` a tool call reads as `api.env`. The runtime hands it to the
Harness each time the instance opens, so an app's shell tool, such as pi-durable's `createBashTool()`,
runs in the working directory the app keeps for that scope:

```ts
envFor: (scope) => () => new NodeExecutionEnv({ cwd: join(workspaces, scope.kind, scope.name) }),
```

`NodeExecutionEnv` is pi-durable's, from `@earendil-works/pi-durable/env/node`; a sandbox supplies its
own. A throw fails the open. Without `envFor` a call has no environment, and a tool that needs one,
such as `bash`, fails it.

## Calls

The call protocol of [`@chia1104/motoko-wire`](../wire#the-call-protocol) maps onto an instance here,
free of any transport:

```ts
runCall(instance, call: Call): Promise<CallResult<call.method>>  // a call parsed with wire's callSchemas
callErrorOf(error): CallError | undefined                       // { code, message }; undefined: not the runtime's
```

`runCall` runs the call on the instance and rejects with what the instance threw. `callErrorOf` maps
the runtime's errors to their codes (`SessionNotFoundError` is `session_not_found`, `SessionBusyError`
`session_busy`, `SessionOwnedError` `session_owned`, `ApprovalNotPendingError` `approval_not_pending`,
`ReplyNotPendingError` `reply_not_pending`, `InvalidRequestError` `invalid_request`, `InvalidCursorError`
`invalid_cursor`, `InstanceClosedError` `instance_closed`, `LeaseHeldError` `lease_held`); for any
other error it returns `undefined`, and the transport reports the error and answers `internal`. What
only a transport knows stays there: whether its caller is readonly (it refuses a call whose
`callSchemas[method].writes` is true) and the app's `authorize`.

## Models and ports per caller

A multi-user server must never let one user's keys or capabilities serve another. A run is durable:
it can be carried on after a restart, when no request and no caller object exist any more. So what
decides credentials and ports is resolved from durable identity only, the instance's scope and the
session, never from a request. As in the Cloudflare Agents SDK, an instance is its caller's own:

**The rule: the scope is the credential boundary.** Give each caller their own instance
(`runtime.get(agent, userId)`, or a name the app derives from the caller and nothing a client can
choose), resolve `modelsFor` from `scope` alone and `portsFor` from `scope` and `sessionId`, and
never route one caller's request to another caller's instance. Within an instance every session
shares its models; `portsFor` may narrow per session, and a session's own tool selection (below) takes
a tool away from it altogether. Give each caller's `Models` an `authContext`
that exposes no environment, or a provider falls back to the server's own key for a caller who has
none.

```ts
import type { AuthContext, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import * as z from "zod";

import { createAgentRuntime, defineAgent, defineTool } from "@chia1104/motoko-core";
import type { AgentHost, ToolContext } from "@chia1104/motoko-core";

// A host whose storage outlives an instance: @chia1104/motoko-node's, or Postgres's.
declare const host: AgentHost;

// ─── The app's own tables (a database in a real server) ───────────────────────

const apiKeys = new Map<string, string>(); // user id → that user's Anthropic key
const webGrants = new Set<string>(); // "<user>/<session>" pairs allowed to search the web

// ─── A definition: no ports, no credentials ───────────────────────────────────

interface AssistantPorts {
  readonly user: string;
  /** Present only in sessions the user granted web search. */
  readonly web?: { search(query: string): Promise<string> };
}

const webSearch = defineTool({
  name: "web_search",
  description: "Search the web",
  tier: "read",
  replay: "safe",
  parameters: z.object({ query: z.string() }),
  async execute({ query }, { ports }: ToolContext<AssistantPorts>) {
    if (ports.web === undefined) return { text: "Web search is not enabled in this conversation." };
    return { text: await ports.web.search(query) };
  },
});

const assistant = defineAgent<AssistantPorts>({
  kind: "assistant",
  instructions: "You are a helpful assistant.",
  tools: [webSearch],
  model: { provider: "anthropic", modelId: "claude-sonnet-5" },
});

// ─── One user's model access ──────────────────────────────────────────────────

/** The user's key, read from the app's table at every model request. */
function userCredentials(user: string): CredentialStore {
  const read = async (): Promise<Credential | undefined> => {
    const key = apiKeys.get(user);
    return key === undefined ? undefined : { type: "api_key", key };
  };
  return {
    read,
    list: async () => (apiKeys.has(user) ? [{ providerId: "anthropic", type: "api_key" }] : []),
    async modify(_providerId, change) {
      const next = await change(await read());
      if (next?.type === "api_key" && next.key !== undefined) apiKeys.set(user, next.key);
      return next ?? (await read());
    },
    delete: async () => void apiKeys.delete(user),
  };
}

// No environment variables or files: a user without a key never falls back to the server's own.
const noAmbientAuth: AuthContext = { env: async () => undefined, fileExists: async () => false };

// ─── The runtime: one instance per user, so the scope is the credential boundary ─

const runtime = createAgentRuntime({
  agents: [assistant],
  host,
  // Resolved when the user's instance opens (also after a restart) and before each submit.
  modelsFor: (scope) => {
    const models = createModels({ credentials: userCredentials(scope.name), authContext: noAmbientAuth });
    models.setProvider(anthropicProvider());
    return models;
  },
  // Resolved for every tool call, right before it runs: a grant withdrawn reaches the next call.
  portsFor: async ({ scope, sessionId }) => ({
    user: scope.name,
    ...(webGrants.has(`${scope.name}/${sessionId}`) && {
      web: { search: async (query: string) => `Results for ${query}` },
    }),
  }),
  // A user who went quiet gives back their Harness and lease after ten minutes.
  closeIdleAfterMs: 10 * 60_000,
});

/** A request handler: the authenticated user reaches their own instance and nobody else's. */
export async function handleMessage(userId: string, sessionId: string, text: string, requestId: string) {
  const session = runtime.get(assistant, userId).session(sessionId);
  return session.submit({ text, requestId });
}

// The user adds a key, or grants web search to a session: nothing to reopen, the next request or
// call reads the tables.
apiKeys.set("user-42", "sk-ant-...");
webGrants.add("user-42/1");

console.log("open instances:", runtime.inspect().open);
```

(`examples/per-caller.ts`, typechecked with the package.)

**`modelsFor(scope)`** returns what `models` would be for that one instance, a `Models` or pi's
function returning one, and may be async (keys usually live in a database). pi-durable reads
`HarnessOptions.models` synchronously at every model request, so the runtime does the async lookup
beforehand and hands pi-durable the newest result:

- It resolves when the instance opens, before anything runs, so a run resumed after a restart or an
  idle close runs on the credentials of now; again before every `submit`, `continue`, `approve`,
  `compact` and `resume`; and on `instance.refreshModels()`.
- A key the user adds or removes while the instance is open: build the `Models` with a pi-ai
  `CredentialStore` that reads the app's table (as the example does), and there is nothing to do:
  pi-ai resolves credentials at every request, so the next request uses the new key, or, once it is
  gone, fails with the provider's "not configured" error and ends its run with `run:end`
  `code: "no_credentials"`. A change that needs another `Models` (a provider registered only when
  the user has a key) reaches the next `submit`, `approve` or `resume` on its own; call
  `refreshModels()` to reach a run already going at its next request.
- A throw or rejection is reported as `models_failed` and held: every model request of the instance
  then fails with `ModelsUnavailableError`, which ends the run it serves (`run:end` with
  `reason: "error"`, `code: "faulted"` and the error's message, which names no cause; pi-durable
  reports the faulted generation too). Reads, sessions and approvals keep working, and the next
  resolution that succeeds restores model access. The newest resolution decides, failed or not, so
  stale credentials are never used after a failed lookup.
- A run resumed after a restart whose credentials can no longer be resolved (the user deleted their
  keys, or the lookup fails) ends that way: with an error the client sees, its committed state
  kept, and nothing sent on anyone else's credentials. A later input runs once the lookup succeeds.

**A key the app holds for a while.** The app keeps the caller's key where its `CredentialStore`
reads it, such as in server memory for a while. A run that finds none, after the key expired or the
server restarted, ends `no_credentials` with its committed state kept, so the client can tell it
from other failures and ask the user for the key. Once the app holds the key again,
`session.continue()` carries the run on and answers the user's message.

**`portsFor({ scope, sessionId, toolCallId, toolName, signal })`** returns one tool call's ports,
and may be async. It runs **per call**, right before the call executes: after its approval, if it
needed one, and again for a replay-safe call a restart reruns. Per call rather than per run because
it is the one point every execution passes through, live or resumed, and because a call can wait
for days for an approval: a grant withdrawn meanwhile, or between two runs, is seen by the next call
without reopening anything. A lookup per call is the cost; an app that needs it cheaper caches by
scope and session itself. A throw or rejection fails that call alone, before it runs: the model
reads ``Tool `<name>` could not run: the app could not provide what it needs for this call``
(`PortsUnavailableError`, without the cause), the run goes on, and the cause is reported as
`ports_failed` with the session and call.

## Closing idle instances

An open instance holds its Harness, its storage and its scope's lease. With `closeIdleAfterMs`, the
runtime closes an instance once it has been idle that long: it closes the instance's streams and
Harness, releases its lease (so another process can take the scope) and lets it go. Off by default.

**Idle** means all of these, continuously for `closeIdleAfterMs` since the last activity (a call's
end, a reader's end, any change to pi-durable's task graph):

- no call of the runtime's under way on the instance (`open`, `createSession`, `listSessions`,
  `submit`, `continue`, `withdraw`, `approve`, `abort`, `compact`, `resume`);
- no event reader attached to any of its sessions;
- `harness.wake()` is not `active`: no task can run now or is running, so no run is going (a run's
  generation or tool calls, queued inputs it will take, a compaction);
- no sleep due within `closeIdleAfterMs` (`harness.wake().at`).

A call parked for an approval does not count: it is committed state, needs no process until its
decision arrives, and `approve()` on a closed instance reopens it and delivers the decision. Inputs
a failed run left queued wait for the next input either way, which reopens the instance.

**Sleeping work.** pi-durable's own timers wake sleeping tasks only while their Harness is open. An
instance whose earliest sleep is due within `closeIdleAfterMs` stays open, and pi-durable wakes it.
One whose sleep is due later closes, and the runtime reopens it at that time: with a `process` host it
keeps a timer for it (the instance shows in `runtime.inspect()` as `dormant` with `wakeAt`, and the
timer keeps a Node.js process alive, as pi's would); opening runs `harness.resume()`, which runs
what is due. A reopen that fails is reported as `reopen_failed` and tried again, unless another
writer holds the scope, which then runs it. With an `alarm` host the runtime arms the host with
`harness.wake()` (`active: false`, and `at` when a sleep is due) just before it closes and keeps no
timer: the host's alarm fires at `at`, the host calls `instance.resume()`, and that reopens the
instance. If that arm fails, the instance stays open and the runtime tries again later.

**Handles keep working.** An `AgentInstance` or `AgentSession` the app holds stays valid: its next
call reopens the instance transparently, and `runtime.get` returns that same handle while the app holds
it. `open()` does not pin an instance open. Explicit `close()`, `runtime.close()`, a lost lease and a
failed storage keep their meaning: the instance ends and never reopens (its calls reject with
`InstanceClosedError`; `runtime.get` makes a fresh one).

**Readers.** An attached reader keeps its instance open however long it waits, so a server ends a
reader (its `signal`) when its client goes away. A reader of an idle session sees nothing until the
session's next commit. After an idle close the session's live log is gone; a client that reconnects
with a cursor from before it reopens the instance and is caught up from committed state (no
`stream:reset`, no repeats), exactly as after a restart.

**Reopening races.** A call that arrives while an idle close is still closing the Harness or
releasing the lease waits for the release, then opens anew: it never fails with `LeaseHeldError`
against its own instance, never opens a second writer, and is not lost. Every caller is counted
before it touches the open Harness, so a close never starts under a call.

**Observing.** `runtime.inspect()` returns `{ open, instances }`: how many instances hold (or are
acquiring or releasing) a lease, and for each instance the runtime holds its `scope`, `state`, the calls
under way, the readers attached and any `wakeAt`. `instance.state` says where one instance is.

Not done here: a cap on open instances. Work an instance left unfinished, or a sleep it closed with,
runs when something next opens that instance in a new process; `runtime.recover()` (below) is that
something at startup.

## Recovering after a restart

The runtime's timer for a sleep lives in its process, and opening an instance is what carries on its
unfinished work. After a restart, or a crash, nothing opens an instance until a call comes for it.
`runtime.recover()` opens every instance the host's `unfinished()` lists, so a run a closed process
cut off, a call it left running, and a sleep it closed with carry on without a call:

```ts
const runtime = createAgentRuntime({ agents, host, models, ports, closeIdleAfterMs: 60_000 });
const { opened, held, unknown, failed } = await runtime.recover({ concurrency: 4 });
```

It returns what it did with each listed scope: `opened` (the open resumed its work), `held` (another
writer holds the scope and carries its work on), `unknown` (an agent kind this runtime does not have)
and `failed` (with the error). Use it with `closeIdleAfterMs`: an instance with nothing to do closes
again once idle, and one with a sleep due later closes and is reopened at that time, as any idle
instance is. Without it, every recovered instance stays open until `close()`.

Run it at startup. Where several processes share a storage, run it again from time to time as well (a
lease TTL apart, say): a crashed process's scopes are `held` until their leases expire, and the next
run takes them over. `recover()` throws a `TypeError` for a host without `unfinished()`.

## Creating a session again

`createSession({ requestId })` is idempotent, as `submit` is: a retry with the same request ID returns
the session the first call made, so a caller whose reply was lost (a dropped connection, a forwarded
call tried again) never makes a second one. The ID is stored on the session's entry in the sessions
record, in the commit that creates the session, and looked up in that same commit, so it holds
across calls made at once, an idle close, a restart and another process on the same storage, and no
crash can leave a session without it.

```ts
const requestId = crypto.randomUUID();
const first = await instance.createSession({ requestId, tools: ["read_note"] });
// The same request, sent again: the same session, as it was made.
const again = await instance.createSession({ requestId });
// again.id === first.id
```

- A retry gets the first session as it is, whatever its other options say, as a `submit` retry gets
  the first submission whatever its text.
- The ID is remembered while its session is listed. Deleting the session forgets it, so the record
  grows with the sessions alone, and a later call with that ID makes a new session; the deleted one
  stays gone.
- Without a `requestId`, every call makes a session.

## What a session runs with

A session's model, thinking level and turn limit, and which of the agent's tools it may use and which
of its calls wait for approval, are chosen per session and stored with it, so they hold after a
restart. `createSession()` sets them, `session.configure()` changes any of them in one commit (a field
left out keeps its value, `null` puts back the agent's), and `session.settings()` reads them back:

```ts
// A session that may only read, asks before every call of it, and takes at most five tool rounds a run.
const { id } = await instance.createSession({ tools: ["read_note"], requiresApproval: ["read"], maxTurns: 5 });
// Later: a bigger model that thinks harder, every tool but delete_note, and write-tier calls run without asking.
await instance.session(id).configure({
  model: { provider: "anthropic", modelId: "claude-opus-5" },
  thinkingLevel: "high",
  tools: { remove: ["delete_note"] },
  requiresApproval: { remove: ["write"] },
});
```

- `model` is pi's `ModelRef`; `null` puts back the model a new session gets, the agent's, else the
  runtime's `defaultModel`, and rejects with a `TypeError` when there is neither. `thinkingLevel` is
  pi-ai's `ModelThinkingLevel`; `null` puts back pi-durable's default. A change to either applies from
  the run's next model request.
- `maxTurns` bounds the tool rounds of one run: the round that reaches it runs its tools, then the run
  ends without an answer (`run:end` with `reason: "error"`, `code: "turn_limit"` and `error: "1 turn"`
  or `"N turns"`), and [`continue`](#continuing-a-run) carries it on. It is an integer, 1 or more;
  anything else rejects with pi-durable's `RangeError` and changes nothing, the other fields of the
  call included. `null` takes the limit away.
- `tools` is a list of the agent's tool names, exactly those, or `{ remove }`: every one but those. The
  model is offered only the session's tools, and a call of another one ends with an error result
  without running. It chooses among the agent's own tools: the tools of [app extensions](#app-extensions)
  stay on whatever it says. It is pi-durable's per-conversation tool selection, which the runtime
  stores as the agent's tools to remove; a change applies from the run's next model request.
- `requiresApproval` is a list of tiers, exactly the calls of those wait, or `{ add, remove }`: the
  agent's policy with `add` tiers gated as well and `remove` tiers not. It applies to every call that
  reaches the gate after the change. A call already waiting keeps waiting, and its decision decides
  it whatever the rule says by then: a declined call never runs, and its question stays visible.

`tools` rejects with a `TypeError` for a tool the agent does not have, and `requiresApproval` for a
tier no tool of the session carries, the app extensions' included, and neither changes anything.
`configure` on a child session rejects with `SessionOwnedError`: its delegate chose what it runs with.
The wire's `createSession` call takes none of these: what a session runs with is the app's to choose.

## Continuing a run

A run that ended without an answer, such as one at its turn limit, keeps what it did: its replies and
its calls' results. `session.continue({ requestId })` starts a run on the session's context as it is,
without a new message, so the model carries on from where the run stopped, on the round's results:

```ts
const { id } = await instance.createSession({ maxTurns: 3 });
// ... a run ends with `run:end` and `code: "turn_limit"`: the user agrees to let it go on.
await instance.session(id).configure({ maxTurns: 10 });
await instance.session(id).continue({ requestId: crypto.randomUUID() });
```

- It is pi-durable's continue. It starts a run only while none is going: a busy session rejects with
  `SessionBusyError` (`session_busy`), and nothing is written. Inputs a failed run left waiting
  (pi-durable's `afterFailedRun: "keep"`, its default) join the run it starts.
- A context with nothing to answer, empty or ending in an answer, ends the run at once without a
  model request: `run:end` with `reason: "error"` and `code: "nothing_to_answer"`.
- It is idempotent on `requestId`, as `submit` is: a retry, also at once, returns the first continue's
  `submissionId` and starts nothing.
- The run resolves the scope's models first, as `submit` does. A child session refuses it with
  `SessionOwnedError`.

pi-durable's continue places no entry, so the stream could not tell from history alone where the
failed run ended and the continued one began. In the commit that admits a continue whose run takes no
waiting input, the runtime writes a `motoko.continue` entry (nothing the model reads) naming the
continue's submission. The stream shows that run as `run:start` there, then its replies and calls, and
its `run:end`, live and in history alike, and a cursor's `run` names that entry, as it names the user
entry of a run an input started (see [Cursors](#cursors)). A run that takes waiting inputs starts at
the first of them, as any run does.

## Compacting a session

pi-durable compacts a session on its own when its context nears the model's window (its `compaction`
settings, in `settings`). `session.compact({ instructions? })` asks for one now: it admits pi-durable's
manual compaction and resolves once it is admitted. The compaction summarizes the session's older
messages, keeping the newest ones verbatim, into what the model reads from then on; the thread keeps
them. It runs while the session keeps working, and its summary lands at once when the session is
idle, else at the run's next boundary. `instructions` is added to the summarization prompt, to say what
the summary should keep.

```ts
await session.compact({ instructions: "Keep every decision the user made." });
```

The stream shows it as it goes, from `pi.live`: `compaction:start` (`reason: "manual"`, or
`threshold` and `overflow` for pi-durable's own), then `session:compacted` with the summary and
`compaction:end`. A compaction whose summary fails (the model's error, after pi-durable's retries) ends
with `compaction:end` and its `error`, and the model reads the messages as they were; the view keeps
the failure until a later compaction succeeds. A compaction runs on the scope's models, resolved again
before `compact` as before `submit`. A child session refuses it with `SessionOwnedError`: what its
sub-agent reads is its delegate's call's.

## Delegates

A delegate hands a task to a sub-agent, which runs in a child session of the caller's, in the same
instance. The call holds no process while it waits: it parks until the child's run ends, then
returns the sub-agent's answer as its result.

```ts
import { defineAgent, defineDelegate } from "@chia1104/motoko-core";

const researcher = defineAgent<NotesPorts>({
  kind: "researcher",
  instructions: "You find what the user's notes say about a topic, and answer in one paragraph.",
  tools: [readNote],
  model: { provider: "anthropic", modelId: "claude-haiku-5" }, // absent: the parent session's model
});

const research = defineDelegate({
  name: "research",
  description: "Hand a research task to the researcher. It sees only the task you write.",
  tier: "read",
  agent: researcher,
});

export const notesAgent = defineAgent<NotesPorts>({
  kind: "notes",
  instructions: "You manage the user's notes.",
  tools: [readNote, deleteNote, research],
});
```

The model calls `research` with `{ task }`. In one commit the call creates the child session, owned
by the call, and configures it to run `researcher` alone: its tools, its instructions, and its model
when it names one. The call then submits the task and parks. A rerun after a crash finds the same
child and the same submission, so no crash makes a second of either. The result is the sub-agent's
answer. A child whose run ends without an answer (aborted, failed) gives an error result that says
why, and the parent's run goes on.

- A delegate is a tool like any other: the agent's policy and the session's rule judge its tier. A
  call that started is never gated again, whatever the rule says by then.
- Each session sees only its own agent's tools and instructions. The runtime sets pi-durable's default
  extension selection (`settings.extensions`) to the instance's agent, after the app extensions that
  select it, so a top-level session, also one made before its agent had delegates, never sees a
  sub-agent's. A child session selects the app extensions that name its sub-agent's kind, then the
  sub-agent's own: by default none of the app's ([App extensions](#app-extensions)).
- Sub-agents have no instances of their own. `createAgentRuntime` throws a `TypeError` for two
  definitions of one kind among its agents and the sub-agents their delegates reach. A definition is
  frozen once made, so delegates never loop.

### Child sessions

A child session is followed, decided in and aborted like any session, under its sub-agent:

- From its start, the delegate's call carries `{ sessionId, agent }` in its details. Wire's
  `delegateOf(item)` reads them, so a UI follows the child with `instance.session(sessionId).events()`.
  The parent's call stays `running` in its view while the child works.
- A call the sub-agent's policy gates waits in the child: approve it with the child session's
  `approve()`. The parent shows no question, and its `approve()` refuses the delegate's call. The
  child's `settings()` lists the sub-agent's tools.
- Only its delegate submits to it: the child's `submit()`, `continue()`, `configure()`, `compact()`
  and `delete()` reject with `SessionOwnedError` (`session_owned`). `listSessions()` leaves it out.
- Aborting the parent aborts the child, through pi-durable's ownership. Aborting the child ends its
  run, and the parent's call returns an error result.
- Deleting the parent deletes its child sessions in the same commit: their readers end, their calls
  reject with `SessionNotFoundError`, and the host erases them with the parent.

The sessions record names a child's sub-agent (`agent`) and its parent (`parent`: the session and the
call). A conversation document, `runtime.calls`, records each delegate's call in the commit that makes
its child: a call listed there has started, so when it sleeps, it waits on its child, not at the gate.

## Deferred tools

A deferred tool's call starts work elsewhere, typically another instance's run, and waits for its
reply. It holds no process while it waits: it parks, so an idle close, a restart or an evicted
Durable Object loses nothing.

```ts
import { defineDeferredTool } from "@chia1104/motoko-core";
import type { DeferredContext } from "@chia1104/motoko-core";

const askTeammate = defineDeferredTool({
  name: "ask_teammate",
  description: "Ask a teammate's agent a question; it answers when its own run ends.",
  tier: "read",
  parameters: z.object({ teammate: z.string(), sessionId: z.string(), question: z.string() }),
  timeoutMs: 60 * 60_000, // an hour; default 24 hours
  async start({ teammate, sessionId, question }, { ports, requestId, replyTo }: DeferredContext<TeamPorts>) {
    // An ask: the teammate's instance answers to `replyTo` when the run this starts ends.
    await ports.team.submit(teammate, sessionId, { text: question, requestId, replyTo });
  },
});
```

The call runs in this order:

1. It passes the approval gate like any call: a gated tier asks before `start` ever runs.
2. It memoizes a token and its deadline, and records both in `runtime.calls` in one commit. From then
   on its sleep is its own, not the gate's: it raises no question, and `approve()` refuses it.
3. It resolves its ports, as an app tool's call does, and runs `start` with a `DeferredContext`:
   `ports`, `signal`, `scope`, `sessionId`, `toolCallId`, `requestId` and `replyTo`. `replyTo` is the
   reply address, `{ scope, sessionId, toolCallId, token }`. A `start` that throws ends the call with
   its message as an error result.
4. It parks until a reply arrives or the deadline passes. The stream shows `reply:wait` with the
   deadline, and the view shows the call `awaiting_reply` until it runs again and ends.
5. Woken, it returns the reply's `text` as its result, an error result if the reply says `isError`,
   or `No reply came in time.` once the deadline passed.

`start` may run again: a crash before the park reruns the call, with the same `requestId` and the
same reply address. So the work it starts must be idempotent by `requestId`, as `submit` is. The
`requestId` is made of the scope, the session and the call, so it is unique across instances.
`cancel(args, context)`, when the tool has one, runs with the same context when the call is stopped
while it waits (its session is aborted), and may run more than once.

`session.reply({ toolCallId, token, text, isError? })` answers the call. It reopens a closed instance,
and takes a child session's call too, since a sub-agent may make a deferred call. In one commit it
checks the token, in constant time, delivers the reply and records it. A reply may come before the
park, while `start` still runs: it is kept, and the park wakes at once. A second reply, also after
the call ended, is `already_replied`, so a delivery may be retried. Everything else is
`ReplyNotPendingError` (`reply_not_pending`): a wrong token, a call with no reply record, one that
ended without a reply, or passed its deadline. Nothing tells these apart, so a guess learns nothing.

### Asks

An ask is a submission with `replyTo`: the asked instance delivers the answer of the run it starts to
that address. `submit` refuses `replyTo` with `InvalidRequestError` (`invalid_request`) on a runtime
without `deliverReply`, or with `whenBusy: "reject"` or `"steer"`, since an ask always queues: its
answer is the answer of a run of its own. Its asker waits for that answer, so `withdraw` refuses an
ask's submission the same way.

The asked side keeps a courier for each ask, a background task of the asked session:

- `submit` creates the courier in one commit, and records it in the session's `runtime.asks` document
  by request ID. Then it submits, notifying the courier when the submission settles. A retry with the
  same request ID finds the courier and returns the first submission.
- The courier submits the same ask itself, in the commit that parks it on the settlement. So a crash
  between the two commits of `submit` loses nothing: the courier makes the submission.
- Once the run ends, the courier reads its answer as a delegate's call does (the last reply's text,
  or why there is none, such as `aborted`), and calls `deliverReply({ to, text, isError }, signal)`.
- `deliverReply` resolving means done: the reply was delivered, or refused for good. Map
  `reply_not_pending` and `session_not_found` to resolving. A rejection is reported as
  `reply_failed`, and the courier sleeps before it tries again: 1 second, doubling, at most 5
  minutes. It gives up a day after its first try, with a last report.
- Deleting the asked session aborts its courier, which sends nothing: the asker's deadline ends its
  call. Aborting the asker stops its call, not the asked run; the reply that comes later is refused,
  and the courier ends.

`deliverReply` is the app's way to reach the asker's home: `session.reply` of the same runtime, a
client of the cluster ([forwarding](../node#forwarding-experimental) takes the call to the home), or a
Durable Object's stub ([asks between objects](../cloudflare#asks-between-objects)).

## App extensions

`extensionsFor(scope)` gives an instance the app's own pi-durable extensions: tools, prompt sections,
hooks, wraps and tasks that use the app's resources, which an agent definition, importable by a
client, cannot hold. It may be async. The runtime calls it each time the instance opens, before the
instance's Harness opens, so work the instance resumes runs with the extensions it ran with. A throw
or rejection fails the open: the call that opened the instance rejects with that error, nothing of
the instance runs, and a call waiting at the gate keeps waiting for a later open.

```ts
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";

const runtime = createAgentRuntime({
  // ...
  extensionsFor: (scope) => [
    { extension: createToolSearchExtension(), tier: () => "read" },
    { extension: mcpTools(scope), tier: (name) => (name.startsWith("mcp_github_") ? "network" : undefined) },
    { extension: traces(scope), agents: ["notes", "researcher"] },
  ],
});
```

- **Tiers.** `tier(toolName)` gives each of the extension's tools its tier, which the agent's policy
  and a session's rule judge as they judge the agent's own tools; `tool:start` and `approval:request`
  carry it. A tool it gives none is `unknown`, and every call of it waits for approval: no policy or
  rule lets it run without a decision, and a rule cannot name `unknown`.
- **Selection.** Every extension is installed in the instance's registry. A session selects the
  extensions whose `agents` name its agent's kind, in the order `extensionsFor` lists them, then its
  agent's own, so the approval gate runs last and judges the arguments the call runs with: `beforeTool`
  hooks, prompt sections and `afterTool` hooks run in selection order, each `beforeTool` seeing the
  arguments the one before it returned. Leaving `agents` out names the instance's own agent alone, so
  a delegate's sub-agent runs an app extension only when `agents` names its kind. A hook meant for
  every session, such as tracing, names the sub-agents' kinds too; a sub-agent of the instance's own
  kind runs what a top-level session runs.
- **Tools.** A session's `tools` choose among its agent's own tools; the app's stay on. To give
  sessions other app tools, run them as another agent. A call of an app tool that parks on its own
  work (its `execute` returns `{ sleep }`) is recorded in `runtime.calls` before it parks, so its
  sleep raises no question and `approve()` refuses it, as a deferred call's does.
- **Hooks.** An app's `beforeTool` hook may watch a call, give it other `arguments` or `block` it. It
  cannot make the call wait: only the gate parks a call before it runs, so a hook's `sleep` ends the
  call as blocked, with an error saying an app hook cannot make a call wait, and nothing asks about
  it. A hook that needs something awaits it. pi-durable runs the whole chain again at every wake,
  registry change and decision, so the runtime memoizes the first `arguments` each hook gives a call:
  the call runs with those, through a decision and a restart, however the hook rewrites them later
  (with the time, say), or if it gives none.
- **Names.** The open fails with a `TypeError` for an extension named `runtime:…` or like another, a
  tool named like an agent's (the instance's agent's or a sub-agent's its delegates reach) or like
  another extension's, or a wrap of an agent's tool. pi-durable runs the last extension that provides
  or wraps a tool of a name, so any of those would run something in an agent's tool's place, past its
  ports.
- **Stable names.** While a session may still have work of an extension, a call waiting at the gate
  or a task its hook asked for, keep giving that extension, its tools and its tasks under the same
  names: register a tool whose backend is down, and fail in its `execute`. When the instance opens
  without it, a call waiting at the gate for its tool ends with `tool_unavailable`, and a task whose
  definition is gone stays blocked, the session busy, until the extension is back or the session is
  aborted.
- **`afterRun`.** A run whose session selects an `afterRun` hook answers, and its `run:end` goes out,
  before the tasks the hook asks for run. Until they end the session is busy: `whenBusy: "reject"`
  throws `SessionBusyError`, and an input that queues starts once they end.
- **Nested calls.** A call a tool makes through pi-durable's `executeTool()` passes the gate too. One
  the gate holds raises no question yet and cannot be decided; aborting the run ends it.

A session whose `tools` an earlier Motoko stored, as pi-durable's list of exactly those tools, runs
none of the app's until `configure({ tools })` sets them again.

## Deleting a session

`session.delete()` stops the session's run (and background work it owns), ends its readers, and hides
it at once: `listSessions()` leaves it out, and every call of it rejects with `SessionNotFoundError`.
Its data goes once the instance's storage is closed, since pi-durable cannot delete a conversation
under an open Harness: when the instance next closes (an idle close, `close()`, or the next close
after a crash) the runtime hands the deleted sessions to the host's `erase()`, with the lease held.
A failure is reported as `erase_failed` and tried again at the next close. A host without `erase()`
only hides the session.

The runtime keeps its sessions in one document (`runtime.sessions`): each session's creation time,
approval rule and request ID, a child session's sub-agent and parent, and the deleted sessions still to erase.
`listSessions()` is one read of it, and a conversation is a session only while it lists it.

A store on pi-durable's SQLite schema erases with `@chia1104/motoko-core/sqlite`, the statements every
such store shares:

```ts
eraseConversations(database, conversations, { prefix?, label? }): Promise<void>
```

`database` is chord's `SqliteDatabase` (`@earendil-works/chord/sqlite`), over a file in Node or a
Durable Object's database. In one transaction it erases each conversation, the conversations its tasks
made, and their entries, tasks, submissions and documents; it skips a conversation that still has
unfinished work or that another conversation forks from. pi-durable has no way to delete a
conversation, so it writes pi-durable's tables directly, against its SQLite schema version 2
(pi-durable 1.6), and refuses a database in any other version, changing nothing. It deletes rows;
overwriting their bytes (`PRAGMA secure_delete`) is the store's to arrange where its database allows it.

## Events from committed state

Each session's stream is derived from committed state by one transcriber, with one set of rules for
history and for each new commit: the entries (`pi.user`, `pi.assistant`, `pi.tool-result`,
`pi.compaction`, and the runtime's `motoko.steer` and `motoko.continue`), the `pi.live` document and
the runtime's approval record. Stored facts (messages, tool calls, results, decisions, run ends) come
from entries and documents; what only `pi.live` shows (a streaming reply, drafts, running output, a
retry wait, a parked question, a compaction going on or the newest one's failure) is superseded by
the stored events that follow it.

### Cursors

A cursor names a position in committed state: the session, the newest entry whose events the client
has all folded, and the run it is in (the entry that started it: its input, or its continue's
`motoko.continue` entry). It stays valid across a restart and in another process that opens the same
storage. A cursor handed out from the live log also carries that log's place (`epoch`, `seq`).
Resuming from a cursor:

1. **Exact, from the log.** While the cursor's place is still in this process's log, the reader
   gets exactly the events after it, live included: no duplicates, no gaps.
2. **From committed state, anywhere else** (after a restart, in another process, or once the
   cursor's run has left the log). The entries of the client's run up to its position are read
   silently to rebuild what the client knows (its open calls, whether it is in a run); the entries
   committed after the position are sent; then the current in-flight state is sent as events the
   reducer applies idempotently: the run going on, the question of each call waiting for approval,
   each decision of a call that left its wait, each deferred call's wait for its reply, running
   output, a retry wait, the reply streamed so far as one delta, drafted calls, and the compaction
   going on or the newest one's failure (`compaction:start` or `compaction:end`). The reader then
   joins the live log where it continues. The last step runs in the session's commit chain, so no
   commit lands between the catch-up and the log. The folded view equals that of a client connected
   all along; the events need not be the same ones.
3. `stream:reset` and a full replay only for a cursor storage cannot honour (it names an entry the
   session does not hold, as after a restore from an older backup). A string that is not a cursor
   of this session rejects with `InvalidCursorError`.

`events()` without `from` replays the session from its start, a page of entries at a time, then
joins the log the same way.

History read from storage shows how a run ended through its entries, except for a run that ended
without an answer and left no entry saying why (`faulted`, `no_model`, `turn_limit`, ...), which
`pi.live.runFailure` describes only until the next run starts. The runtime takes such a run's end from
its input's settlement, or its continue's (`unanswered`, with the same reason and detail), which
pi-durable keeps.
pi-durable scans submissions only on the `Storage`, so the runtime reads the instance's own Storage for
it.

### What is held in memory

- A session's stream (its observer, transcriber and log) exists only while it is needed: a reader
  is iterating, a call (`submit`, `continue`, `approve`, `abort`, `withdraw`, `compact`) is under way,
  or the session has work (a run, or queued input). A session with no reader and no run holds
  nothing; its stream closes and the next reader or call opens it again from committed state.
- While it exists, the log holds the events since the current run's `run:start`, plus the previous
  run's events only while an attached reader has not read them yet. The transcriber holds the
  current run's open calls and questions. So what is held is bounded by the run, not by the
  session's history. A reader that falls behind the log carries on from committed state.
- A catch-up reads history a page (200 entries) at a time and holds one page of events;
  rebuilding the state of a run (for a resumed client, or a stream that opens mid-run) reads that
  run's entries.
- pi-durable's own view of the conversation is a window of at most 32 entries.

A reader keeps its session's stream open until it ends (the loop breaks or returns, or its `signal`
aborts).

## Durable approval

A call whose tier the policy gates (the session's own rule, if it has one) is parked by a
`beforeTool` hook that returns `{ sleep: { signals: [ApprovalSignal.key(callId)] } }`, pi-durable
1.6's gate. The park is the tool task's committed state; nothing waits in memory. A delegate's call
also sleeps once it has started, while its child works, and so does a deferred call while it waits for its reply,
and an app tool's call that parks on its own work. Those parks are their own, recorded in `runtime.calls`, so they
raise no question. The gate judges every call of a session, the app extensions' tools' too.
`approve()` delivers every decision of its batch with `tx.signal()` in one commit that also records them in a
conversation document (`runtime.approvals`): if any call of the batch is not waiting, the commit is
discarded and nothing is decided (`ApprovalNotPendingError` names that call). Restarting,
reinstalling the registry or the decision arriving reruns the gate, which reads the signal first and
passes, or blocks a declined call, whatever the session's rule says by then; an `afterTool` hook then
hands the model `The operator declined this call: <comment>` as the call's result.

## What Motoko owns, and what is pi's

Motoko exports what it adds: `defineTool` (zod parameters, ports, tiers), `defineDelegate`,
`defineDeferredTool`, `defineAgent`, the host contract with `assertScope`, `scopeKey`, `inProcessLeases` and
the `@chia1104/motoko-core/testing` suite, `createAgentRuntime`, the session, approval, reply and recovery
API, the error classes (which hide pi's own, such as `ConversationBusy`), the wire events, and
`eraseConversations` of `@chia1104/motoko-core/sqlite`. Everything else is pi's and comes from
`@earendil-works/*`: `createModels` and the providers from `@earendil-works/pi-ai`, `MemoryStorage`,
`SqliteStorage` and the `Storage`, `Wake`, `ModelRef` and `Report` types from `@earendil-works/pi-durable`,
`openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node`, `JsonValue` from
`@earendil-works/chord/json`.
