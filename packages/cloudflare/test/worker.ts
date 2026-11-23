import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { Agent } from "agents";
import { Lifecycle } from "agents/lifecycle";
import type { Connection, WSMessage } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { DurableObject, env } from "cloudflare:workers";
import * as z from "zod";

import {
  defineAgent,
  defineDeferredTool,
  defineDelegate,
  defineTool,
  LeaseHeldError,
  ReplyNotPendingError,
  SessionNotFoundError,
} from "@chia1104/motoko-core";
import type { AgentInstance, AgentStore, OutgoingReply, ReplyAddress, ReplyInput } from "@chia1104/motoko-core";
import type { AgentWireEvent } from "@chia1104/motoko-wire";

import { setWakeTimingForTests } from "../src/capability.ts";
import { durableObjectStore, MotokoCapability } from "../src/index.ts";
import type { MotokoAuthorize, MotokoCall } from "../src/index.ts";

/** What the faux model answers, one step per model request. */
export type Step =
  | { readonly text: string }
  | { readonly tool: string; readonly args: Parameters<typeof fauxToolCall>[1] }
  | { readonly error: string }
  /** A request that answers only once `release()` gives its text: the run is under way until then. */
  | { readonly hold: true };

/**
 * Each object's script, the model requests it saw and its held request, by object name. Module state outlives an
 * object's instance, as `abortAllDurableObjects()` resets it, so a script spans the instance that died and the one its
 * alarm starts.
 */
const scripts = new Map<string, Step[]>();
const requests = new Map<string, number>();
const held = new Map<string, (text: string) => void>();
/** The calls a `guarded:…` object's `authorize` saw, with the id of the connection each came on. */
const authorized = new Map<string, (MotokoCall & { readonly connection: string })[]>();

/**
 * An object named `guarded:…` decides each call after a turn of the event loop, as an app reading its own storage would:
 * it records the call, refuses `deleteSession` and throws on `abort`.
 */
function guard(name: string): MotokoAuthorize | undefined {
  if (!name.startsWith("guarded:")) return undefined;
  return async (connection, call) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    authorized.set(name, [...(authorized.get(name) ?? []), { connection: connection.id, ...call }]);
    if (call.method === "abort") throw new Error("The app's check failed");
    return call.method !== "deleteSession";
  };
}

/** The `held:…` objects whose scope's lease another writer holds now, by name. */
const heldLeases = new Set<string>();

/**
 * The object's own store, but refusing its lease with core's `LeaseHeldError` while `heldLeases` names the object, as
 * a store several objects share refuses one object the scope another object holds.
 */
function holdable(name: string, store: AgentStore): AgentStore {
  return {
    lease: (scope) => (heldLeases.has(name) ? Promise.reject(new LeaseHeldError(scope)) : store.lease(scope)),
    storage: (scope, lease) => store.storage(scope, lease),
  };
}

/** The `gated:…` objects' gates, by name: the first commit to reach one waits there until it opens. */
const commitGates = new Map<string, { reached: boolean; readonly opened: Promise<void>; readonly open: () => void }>();

/** The object's own store, but its storage's commits pass the object's gate in `commitGates`, if one is up. */
function gated(name: string, store: AgentStore): AgentStore {
  return {
    lease: (scope) => store.lease(scope),
    async storage(scope, lease) {
      const storage = await store.storage(scope, lease);
      return new Proxy(storage, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property !== "commit") return typeof value === "function" ? value.bind(target) : value;
          return async (...args: Parameters<typeof storage.commit>) => {
            const gate = commitGates.get(name);
            if (gate !== undefined && !gate.reached) {
              gate.reached = true;
              await gate.opened;
            }
            return target.commit(...args);
          };
        },
      });
    },
  };
}

/** A connection whose upgrade asked for `?readonly` is marked readonly by the SDK. */
const readonlyUpgrade = (request: Request) => new URL(request.url).searchParams.has("readonly");

function answer(name: string, step: Step | undefined) {
  if (step === undefined) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "no scripted step" });
  if ("hold" in step) {
    return new Promise<string>((resolve) => held.set(name, resolve)).then((text) => fauxAssistantMessage(text));
  }
  if ("error" in step) return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.error });
  if ("tool" in step) return fauxAssistantMessage(fauxToolCall(step.tool, step.args), { stopReason: "toolUse" });
  return fauxAssistantMessage(step.text);
}

/** pi-ai's faux model, answering object `name`'s script. */
function scriptedModels(name: () => string) {
  const faux = fauxProvider();
  const respond: FauxResponseFactory = () => {
    requests.set(name(), (requests.get(name()) ?? 0) + 1);
    return answer(name(), scripts.get(name())?.shift());
  };
  faux.setResponses(Array.from({ length: 64 }, () => respond));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
}

const shout = defineTool({
  name: "shout",
  description: "Say it louder",
  tier: "read",
  parameters: z.object({ text: z.string() }),
  async execute({ text }) {
    return { text: text.toUpperCase() };
  },
});

const save = defineTool({
  name: "save",
  description: "Save a note",
  tier: "write",
  parameters: z.object({ text: z.string() }),
  async execute({ text }) {
    return { text: `Saved ${text}.` };
  },
});

/** The sub-agent `ask` hands a task to, in a child session. */
const helper = defineAgent({ kind: "helper", instructions: "You help.", tools: [shout] });

const ask = defineDelegate({ name: "ask", description: "Hand a task to the helper", tier: "read", agent: helper });

/** The reply address each object's last `relay` call handed out, by object name. */
const replyAddresses = new Map<string, ReplyAddress>();
/** How many deliveries an object's `deliverReply` fails before one goes through, by object name. */
const failingDeliveries = new Map<string, number>();
/** How each delivery an object's `deliverReply` made was answered, failed ones included, by object name. */
const deliveries = new Map<string, string[]>();

/**
 * A deferred tool: it asks session `session` of the object named `to` over RPC, with its reply address; with no `to`,
 * it asks nobody, and the test replies itself.
 */
const relay = defineDeferredTool({
  name: "relay",
  description: "Ask another agent",
  tier: "read",
  parameters: z.object({ to: z.string(), session: z.string(), text: z.string() }),
  async start({ to, session, text }, { scope, requestId, replyTo }) {
    replyAddresses.set(scope.name, replyTo);
    if (to !== "") await env.MOTOKO.getByName(to).ask(session, text, requestId, replyTo);
  },
});

/** An object's `deliverReply`: the asking object's `reply` over RPC, failing while `failingDeliveries` says so. */
async function deliver(from: string, { to, text, isError }: OutgoingReply) {
  const failures = failingDeliveries.get(from) ?? 0;
  const seen = deliveries.get(from) ?? [];
  deliveries.set(from, seen);
  if (failures > 0) {
    failingDeliveries.set(from, failures - 1);
    seen.push("failed");
    throw new Error("The asking object cannot be reached");
  }
  const reply = { toolCallId: to.toolCallId, token: to.token, text, isError };
  seen.push(await env.MOTOKO.getByName(to.scope.name).reply(to.sessionId, reply));
}

/** Its write-tier calls wait for a decision. */
export const assistant = defineAgent({
  kind: "assistant",
  instructions: "You answer.",
  tools: [shout, save, ask, relay],
  policy: { requiresApproval: ["write"] },
});

export interface Transcript {
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly end: { readonly reason: string; readonly code?: string };
}

/** The session's events from its start until `until` matches one, which it returns. */
async function readUntil<T>(
  instance: AgentInstance,
  sessionId: string,
  until: (event: AgentWireEvent) => T | undefined,
  timeoutMs = 10_000,
): Promise<{ readonly events: readonly AgentWireEvent[]; readonly found: T }> {
  const events: AgentWireEvent[] = [];
  for await (const { event } of instance.session(sessionId).events({ signal: AbortSignal.timeout(timeoutMs) })) {
    events.push(event);
    const found = until(event);
    if (found !== undefined) return { events, found };
  }
  throw new Error(`The stream ended first; read: ${events.map((event) => event.type).join(", ")}`);
}

/** The session's messages until its first run ends. */
async function transcript(instance: AgentInstance, sessionId: string): Promise<Transcript> {
  const { events, found } = await readUntil(instance, sessionId, (event) =>
    event.type === "run:end"
      ? { reason: event.reason, ...(event.code !== undefined && { code: event.code }) }
      : undefined,
  );
  const messages = events.flatMap((event): Transcript["messages"] => {
    if (event.type === "user") return [{ role: "user", text: event.text }];
    if (event.type === "assistant:end" && event.text !== "") return [{ role: "assistant", text: event.text }];
    return [];
  });
  return { messages, end: found };
}

interface NotesState {
  readonly notes: readonly string[];
}

/** The app's own frame on a socket Motoko also serves: answered with `echoed`. */
function echo(connection: Connection, message: WSMessage, seen: string[]) {
  if (typeof message !== "string") return;
  seen.push(message);
  const frame = JSON.parse(message) as { type?: string; text?: string };
  if (frame.type === "echo") connection.send(JSON.stringify({ type: "echoed", text: frame.text }));
}

/**
 * An Agents SDK agent with Motoko installed: its sessions over the object's RPC and over its WebSockets, beside the
 * SDK's own state and the app's own frames.
 */
export class MotokoTestAgent extends Agent<Cloudflare.Env, NotesState> {
  override initialState: NotesState = { notes: [] };
  readonly #faux = scriptedModels(() => this.name);
  /** The frames the app's `onMessage` saw, in this instance of the object. */
  readonly #seen: string[] = [];
  readonly motoko = new MotokoCapability({
    agent: assistant,
    models: this.#faux.models,
    defaultModel: this.#faux.model,
    ports: {},
    connections: this,
    deliverReply: (reply) => deliver(this.name, reply),
    // An object named `idle:…` closes its instance once idle.
    ...(this.name.startsWith("idle:") && { closeIdleAfterMs: 200 }),
    // An object named `held:…` finds its scope's lease held by another writer while `holdLease(true)` says so.
    ...(this.name.startsWith("held:") && {
      store: holdable(this.name, durableObjectStore(this.ctx.storage, { kind: assistant.kind, name: this.name })),
    }),
    // An object named `gated:…` holds its next commit at a gate while `holdNextCommit()` put one up.
    ...(this.name.startsWith("gated:") && {
      store: gated(this.name, durableObjectStore(this.ctx.storage, { kind: assistant.kind, name: this.name })),
    }),
    authorize: guard(this.name),
  });

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.lifecycle.use(this.motoko);
    setWakeTimingForTests(this.motoko, { heartbeatMs: 200 });
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    echo(connection, message, this.#seen);
  }

  override shouldConnectionBeReadonly(_connection: Connection, { request }: { request: Request }): boolean {
    return readonlyUpgrade(request);
  }

  /** The calls `authorize` saw, on a `guarded:…` object. Touches nothing of Motoko. */
  async authorized(): Promise<readonly (MotokoCall & { readonly connection: string })[]> {
    return authorized.get(this.name) ?? [];
  }

  /** The frames the app's `onMessage` saw. Touches nothing of Motoko. */
  async seen(): Promise<readonly string[]> {
    return this.#seen;
  }

  /**
   * Submits, reading the session's events from `from` meanwhile, and returns them once the run ends: what a reader
   * from that cursor gets while the run goes on.
   */
  async submitAndRead(sessionId: string, text: string, requestId: string, from: string): Promise<AgentWireEvent[]> {
    const instance = await this.motoko.instance();
    const events: AgentWireEvent[] = [];
    const read = (async () => {
      const stream = instance.session(sessionId).events({ from, signal: AbortSignal.timeout(10_000) });
      for await (const { event } of stream) {
        events.push(event);
        if (event.type === "run:end") return;
      }
    })();
    await instance.session(sessionId).submit({ text, requestId });
    await read;
    return events;
  }

  /** Has another writer hold this `held:…` object's lease from now on, or let it go. Touches nothing of Motoko. */
  async holdLease(held: boolean): Promise<void> {
    if (held) heldLeases.add(this.name);
    else heldLeases.delete(this.name);
  }

  /** Puts up a gate on this `gated:…` object's next commit. Touches nothing of Motoko. */
  async holdNextCommit(): Promise<void> {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    commitGates.set(this.name, { reached: false, opened, open });
  }

  /** Whether a commit waits at the gate. Touches nothing of Motoko. */
  async commitHeld(): Promise<boolean> {
    return commitGates.get(this.name)?.reached ?? false;
  }

  /** Opens the gate: the commit that waits there goes on. Touches nothing of Motoko. */
  async releaseCommit(): Promise<void> {
    commitGates.get(this.name)?.open();
    commitGates.delete(this.name);
  }

  /** What the model answers from now on. Touches nothing of Motoko. */
  async script(steps: readonly Step[]): Promise<void> {
    scripts.set(this.name, [...steps]);
  }

  /** The model requests this object made. Touches nothing of Motoko. */
  async requests(): Promise<number> {
    return requests.get(this.name) ?? 0;
  }

  /** Answers the held request with `text`. Whether one was held. */
  async release(text: string): Promise<boolean> {
    const resolve = held.get(this.name);
    held.delete(this.name);
    resolve?.(text);
    return resolve !== undefined;
  }

  /** Shortens the wake's timings for this instance of the object. */
  async wakeTiming(timing: { readonly heartbeatMs?: number; readonly waitBudgetMs?: number }): Promise<void> {
    setWakeTimingForTests(this.motoko, timing);
  }

  async createSession(): Promise<string> {
    const instance = await this.motoko.instance();
    return (await instance.createSession()).id;
  }

  async submit(sessionId: string, text: string, requestId: string): Promise<string> {
    const instance = await this.motoko.instance();
    return (await instance.session(sessionId).submit({ text, requestId })).submissionId;
  }

  async transcript(sessionId: string): Promise<Transcript> {
    return transcript(await this.motoko.instance(), sessionId);
  }

  /** When the session's model request is to be sent again, once it waits to be. */
  async retryAt(sessionId: string): Promise<number> {
    const instance = await this.motoko.instance();
    const { found } = await readUntil(instance, sessionId, (event) =>
      event.type === "retry:wait" ? event.at : undefined,
    );
    return found;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await (await this.motoko.instance()).session(sessionId).delete();
  }

  /** Submits an ask, as another object's `relay` does: its run's answer goes to `replyTo`. */
  async ask(sessionId: string, text: string, requestId: string, replyTo: ReplyAddress): Promise<string> {
    return (await (await this.motoko.instance()).session(sessionId).submit({ text, requestId, replyTo })).submissionId;
  }

  /** A reply to a deferred call of the session, as the asked object sends it. One refused for good is `refused`. */
  async reply(sessionId: string, input: ReplyInput): Promise<string> {
    try {
      return (await (await this.motoko.instance()).session(sessionId).reply(input)).outcome;
    } catch (error) {
      if (error instanceof ReplyNotPendingError || error instanceof SessionNotFoundError) return "refused";
      throw error;
    }
  }

  /** The reply address this object's last `relay` call handed out. Touches nothing of Motoko. */
  async replyAddress(): Promise<ReplyAddress | undefined> {
    return replyAddresses.get(this.name);
  }

  /** Has this object's next `count` deliveries fail. Touches nothing of Motoko. */
  async failDeliveries(count: number): Promise<void> {
    failingDeliveries.set(this.name, count);
  }

  /** How this object's deliveries were answered. Touches nothing of Motoko. */
  async deliveries(): Promise<readonly string[]> {
    return deliveries.get(this.name) ?? [];
  }

  async listSessions(): Promise<string[]> {
    return (await (await this.motoko.instance()).listSessions()).map((session) => session.id);
  }

  /** Where the instance is; reading it opens nothing. */
  async instanceState(): Promise<string> {
    return (await this.motoko.instance()).state;
  }

  /** The session's entries in pi-durable's tables, read from the object's database directly. */
  async storedEntries(sessionId: string): Promise<number> {
    const [row] = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM motoko_entries WHERE conversation_id = ?",
        Number(sessionId),
      )
      .toArray();
    return row?.count ?? 0;
  }

  /** Arms the host `active` as the runtime does before a call, with no call after it: a wake with nothing to do. */
  async armActive(): Promise<void> {
    const { wake } = this.motoko.host;
    if (wake.kind === "alarm") await wake.arm(this.motoko.scope, { active: true });
  }

  /** The time the Motoko wake job is due, or `null` without one. */
  async wakeJob(): Promise<number | null> {
    const row = this.ctx.storage.sql
      .exec<{ time: number }>("SELECT time FROM cf_agents_jobs WHERE id = 'motoko-wake'")
      .toArray()[0];
    return row?.time ?? null;
  }

  /** The SDK's own scheduler: `noted(note)` runs in `seconds`. */
  async scheduleNote(note: string, seconds: number): Promise<void> {
    await this.schedule(seconds, "noted", { note });
  }

  async noted({ note }: { readonly note: string }): Promise<void> {
    this.setState({ notes: [...this.state.notes, note] });
  }

  async notes(): Promise<readonly string[]> {
    return this.state.notes;
  }
}

const conformance = defineAgent({ kind: "conformance", instructions: "You answer.", tools: [] });

/** A plain Durable Object with the Lifecycle and Motoko installed, for the host and storage conformance suites. */
export class MotokoConformanceObject extends DurableObject<Cloudflare.Env> {
  readonly motoko = new MotokoCapability({
    agent: conformance,
    models: createModels(),
    defaultModel: { provider: "conformance", modelId: "none" },
    ports: {},
  });
  readonly lifecycle = Lifecycle.install(this).use(this.motoko);
}

/** A plain Durable Object with the `WebSockets` capability and Motoko serving its socket protocol on it. */
export class MotokoSocketObject extends DurableObject<Cloudflare.Env> {
  readonly #faux = scriptedModels(() => this.ctx.id.name ?? "");
  readonly #seen: string[] = [];
  readonly webSockets = new WebSockets({
    handlers: { onMessage: (connection, message) => echo(connection, message, this.#seen) },
    readonly: (_connection, { request }) => readonlyUpgrade(request),
  });
  readonly motoko = new MotokoCapability({
    agent: assistant,
    models: this.#faux.models,
    defaultModel: this.#faux.model,
    ports: {},
    connections: this.webSockets,
  });
  readonly lifecycle = Lifecycle.install(this).use(this.motoko).use(this.webSockets);

  async script(steps: readonly Step[]): Promise<void> {
    scripts.set(this.ctx.id.name ?? "", [...steps]);
  }

  async seen(): Promise<readonly string[]> {
    return this.#seen;
  }

  /** The model requests this object made. */
  async requests(): Promise<number> {
    return requests.get(this.ctx.id.name ?? "") ?? 0;
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
