import type { Connection, WSMessage } from "agents/lifecycle";
import * as z from "zod";

import { callErrorOf, InstanceClosedError, InvalidCursorError, runCall } from "@chia1104/motoko-core";
import type { AgentInstance } from "@chia1104/motoko-core";
import { cursorSchema, decodeCursor } from "@chia1104/motoko-wire";
import type { CallError, Cursor } from "@chia1104/motoko-wire";
import { callFrameSchema, motokoCalls, motokoFrame } from "@chia1104/motoko-wire/socket";
import type {
  MotokoCall,
  MotokoErrorBody,
  MotokoErrorCode,
  MotokoMethod,
  ServerFrame,
} from "@chia1104/motoko-wire/socket";

/**
 * The connections Motoko serves: the `Agent` itself, or the `WebSockets` capability of a plain Durable Object. Motoko
 * reads them, their state and the SDK's readonly mark, by the name each gives it; the app's own frames on them stay the
 * app's.
 */
export type MotokoConnections = { getConnections(): Iterable<Connection> } & (
  | { isConnectionReadonly(connection: Connection): boolean }
  | { isReadonly(connection: Connection): boolean }
);

/** Decides whether `connection` may make `call`; a call it refuses is answered `forbidden` and runs nothing. */
export type MotokoAuthorize = (connection: Connection, call: MotokoCall) => boolean | Promise<boolean>;

/** `WebSocket.OPEN`. */
const OPEN = 1;

/**
 * Where a connection's state keeps what Motoko follows for it, beside the app's own keys: each session's cursor right
 * after the last event sent, or `null` before the first. It rides the connection's hibernation attachment.
 */
const STATE_KEY = "motoko";

/** The sessions one connection may follow, which keeps its state well inside the attachment's 2 KiB. */
export const MAX_SUBSCRIPTIONS = 8;

const followedSchema = z.record(z.string(), cursorSchema.nullable());

/** A refusal of the socket layer's own, beside core's errors. */
class RequestError extends Error {
  readonly code: MotokoErrorCode;
  constructor(code: MotokoErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function send(connection: Connection, frame: ServerFrame): boolean {
  if (connection.readyState !== OPEN) return false;
  try {
    connection.send(JSON.stringify(frame));
    return true;
  } catch {
    // The socket closed between the check and the send.
    return false;
  }
}

/** What a connection's state says it follows; nothing for state of the app's that is not an object. */
function followedOf(connection: Connection): Record<string, Cursor | null> {
  const state: unknown = connection.state;
  if (typeof state !== "object" || state === null || !(STATE_KEY in state)) return {};
  const parsed = followedSchema.safeParse((state as Record<string, unknown>)[STATE_KEY]);
  return parsed.success ? parsed.data : {};
}

/** One session a connection follows in this isolate. */
interface Reader {
  readonly stop: AbortController;
  cursor: Cursor | null;
}

/**
 * Motoko's socket protocol on the object's connections (`@chia1104/motoko-wire/socket`): the calls, and the events of the sessions
 * each connection follows, read with `session.events({ from })` and sent as they come.
 *
 * What a connection follows lives in its state, written after every event sent, so it outlives the isolate: a socket
 * survives hibernation, and when the object wakes `reattach()` follows on from each connection's last cursor. The
 * in-memory readers are only this isolate's copy of it.
 */
export class MotokoSockets {
  readonly #connections: MotokoConnections;
  readonly #instance: () => AgentInstance;
  readonly #report: (error: unknown) => void;
  readonly #authorize: MotokoAuthorize | undefined;
  readonly #readers = new Map<Connection, Map<string, Reader>>();
  #disposed = false;

  constructor(
    connections: MotokoConnections,
    instance: () => AgentInstance,
    report: (error: unknown) => void,
    authorize?: MotokoAuthorize,
  ) {
    this.#connections = connections;
    this.#instance = instance;
    this.#report = report;
    this.#authorize = authorize;
  }

  /** Follows on, from its state, every session an open connection followed before the object slept or was evicted. */
  reattach(): void {
    for (const connection of this.#connections.getConnections()) {
      for (const [sessionId, cursor] of Object.entries(followedOf(connection))) {
        if (!this.#readersOf(connection).has(sessionId)) this.#follow(connection, sessionId, cursor);
      }
    }
  }

  /** Answers a frame of Motoko's on an open connection. Anything else, the SDK's or the app's, is not claimed. */
  message(ws: WebSocket, message: WSMessage): boolean {
    const raw = motokoFrame(message);
    if (raw === undefined) return false;
    const connection = this.#connectionOf(ws);
    if (connection === undefined) return false;
    const call = callFrameSchema.safeParse(raw);
    if (!call.success) {
      const id = typeof raw.id === "string" ? raw.id : undefined;
      if (id !== undefined) send(connection, { type: "motoko:error", id, error: invalid(call.error) });
      return true;
    }
    this.#answer(connection, call.data.id, call.data.method, call.data.params);
    return true;
  }

  /** The connection closed: its readers stop. What it followed stays in its state, which closes with it. */
  closed(ws: WebSocket): void {
    // SAFETY: a connection is its WebSocket, with the SDK's fields added; the map is keyed by that one object.
    const connection = ws as Connection;
    for (const reader of this.#readers.get(connection)?.values() ?? []) reader.stop.abort();
    this.#readers.delete(connection);
  }

  /** The object is going away: every reader stops, and none is started again. */
  dispose(): void {
    this.#disposed = true;
    for (const readers of this.#readers.values()) for (const reader of readers.values()) reader.stop.abort();
    this.#readers.clear();
  }

  /** The open connection `ws` is, as the connections source wraps it. */
  #connectionOf(ws: WebSocket): Connection | undefined {
    for (const connection of this.#connections.getConnections()) if (connection === ws) return connection;
    return undefined;
  }

  #readersOf(connection: Connection): Map<string, Reader> {
    let readers = this.#readers.get(connection);
    if (readers === undefined) {
      readers = new Map();
      this.#readers.set(connection, readers);
    }
    return readers;
  }

  // ─── Calls ─────────────────────────────────────────────────────────────────

  /**
   * Answers one call: a readonly connection's call that writes, or one `authorize` refuses, is `forbidden`; any other
   * runs. Its reply goes out in the same turn as the handler returns, after `authorize` settles too, so `subscribe`'s
   * result precedes the first event of the reader it starts, which sends nothing before its first await.
   */
  #answer(connection: Connection, id: string, method: MotokoMethod, params: unknown) {
    const reply = (result: unknown) => void send(connection, { type: "motoko:result", id, result });
    const fail = (error: unknown) => void send(connection, { type: "motoko:error", id, error: this.#errorOf(error) });
    const parsed = motokoCalls[method].params.safeParse(params);
    if (!parsed.success) {
      send(connection, { type: "motoko:error", id, error: invalid(parsed.error) });
      return;
    }
    if (motokoCalls[method].writes && this.#isReadonly(connection)) {
      fail(new RequestError("forbidden", "A readonly connection only follows sessions"));
      return;
    }
    // SAFETY: `parsed` is `method`'s params, parsed with its own schema.
    const call = { method, params: parsed.data } as MotokoCall;
    const run = (allowed: boolean) => {
      // It closed while `authorize` decided: nothing to answer, and no reader to start.
      if (connection.readyState !== OPEN) return;
      if (allowed !== true) {
        fail(new RequestError("forbidden", `This connection may not ${method}`));
        return;
      }
      let outcome: unknown;
      try {
        outcome = this.#run(connection, call);
      } catch (error) {
        fail(error);
        return;
      }
      if (outcome instanceof Promise) outcome.then(reply, fail);
      else reply(outcome);
    };
    let allowed: boolean | Promise<boolean>;
    try {
      allowed = this.#authorize?.(connection, call) ?? true;
    } catch (error) {
      fail(error);
      return;
    }
    if (allowed instanceof Promise) allowed.then(run, fail);
    else run(allowed);
  }

  /** The SDK's readonly mark on the connection, as the connections source reads it. */
  #isReadonly(connection: Connection): boolean {
    const connections = this.#connections;
    return "isConnectionReadonly" in connections
      ? connections.isConnectionReadonly(connection)
      : connections.isReadonly(connection);
  }

  /** The socket's own calls here; the instance's in core's `runCall`. */
  #run(connection: Connection, call: MotokoCall): unknown {
    switch (call.method) {
      case "subscribe":
        this.#subscribe(connection, call.params);
        return null;
      case "unsubscribe":
        this.#unfollow(connection, call.params.sessionId);
        return null;
      default:
        return runCall(this.#instance(), call);
    }
  }

  #subscribe(connection: Connection, { sessionId, from }: Extract<MotokoCall, { method: "subscribe" }>["params"]) {
    if (from !== undefined && decodeCursor(from)?.session !== sessionId) throw new InvalidCursorError(from);
    const readers = this.#readersOf(connection);
    if (!readers.has(sessionId) && readers.size >= MAX_SUBSCRIPTIONS) {
      throw new RequestError("too_many_subscriptions", `A connection follows at most ${MAX_SUBSCRIPTIONS} sessions`);
    }
    readers.get(sessionId)?.stop.abort();
    this.#follow(connection, sessionId, from ?? null);
  }

  #errorOf(error: unknown): MotokoErrorBody {
    if (error instanceof RequestError) return { code: error.code, message: error.message };
    return this.#callErrorOf(error);
  }

  /** Core's errors by their code; anything else is not the client's to read, so the object reports it. */
  #callErrorOf(error: unknown): CallError {
    const known = callErrorOf(error);
    if (known !== undefined) return known;
    this.#report(error);
    return { code: "internal", message: "Internal error" };
  }

  // ─── Following ─────────────────────────────────────────────────────────────

  #follow(connection: Connection, sessionId: string, from: Cursor | null) {
    if (this.#disposed) return;
    const reader: Reader = { stop: new AbortController(), cursor: from };
    this.#readersOf(connection).set(sessionId, reader);
    this.#store(connection);
    void this.#read(connection, sessionId, reader);
  }

  #unfollow(connection: Connection, sessionId: string) {
    const readers = this.#readers.get(connection);
    const reader = readers?.get(sessionId);
    if (readers === undefined || reader === undefined) return;
    reader.stop.abort();
    readers.delete(sessionId);
    this.#store(connection);
  }

  /**
   * Sends the session's events from the reader's cursor until it is stopped. A stream that ends unstopped (the
   * session was deleted, or its instance closed) is read again from where it stopped: a deleted session fails then,
   * and a closed instance reopens. Two in a row that end with nothing sent end the follow.
   */
  async #read(connection: Connection, sessionId: string, reader: Reader): Promise<void> {
    const { signal } = reader.stop;
    try {
      for (let retried = false; ;) {
        const from = reader.cursor ?? undefined;
        const events = this.#instance()
          .session(sessionId)
          .events({ ...(from !== undefined && { from }), signal });
        let sent = false;
        for await (const { cursor, event } of events) {
          // Nothing between the check and the send, so a stopped reader sends nothing more.
          if (signal.aborted) return;
          if (!send(connection, { type: "motoko:event", sessionId, cursor, event })) return;
          sent = true;
          reader.cursor = cursor;
          this.#store(connection);
        }
        if (signal.aborted) return;
        if (!sent && retried) throw new InstanceClosedError(this.#instance().scope, "closed");
        retried = !sent;
      }
    } catch (error) {
      if (signal.aborted) return;
      this.#unfollow(connection, sessionId);
      send(connection, { type: "motoko:ended", sessionId, error: this.#callErrorOf(error) });
    }
  }

  /**
   * Writes what the connection follows into its state, beside the app's keys. State of the app's that is not an
   * object is left alone: the connection's follows then last only as long as this isolate.
   */
  #store(connection: Connection) {
    const followed = Object.fromEntries(
      [...(this.#readers.get(connection) ?? [])].map(([sessionId, reader]) => [sessionId, reader.cursor]),
    );
    try {
      connection.setState((state: unknown) => {
        if (state !== null && (typeof state !== "object" || Array.isArray(state))) return state;
        const { [STATE_KEY]: _previous, ...rest } = (state ?? {}) as Record<string, unknown>;
        if (Object.keys(followed).length > 0) return { ...rest, [STATE_KEY]: followed };
        return Object.keys(rest).length > 0 ? rest : null;
      });
    } catch (error) {
      // The attachment refused it (too large with the app's state): the follows last as long as this isolate.
      this.#report(error);
    }
  }
}

function invalid(error: z.ZodError): MotokoErrorBody {
  return { code: "invalid_request", message: z.prettifyError(error) };
}
