import type { Connection, WSMessage } from "agents/lifecycle";
import * as z from "zod";

import { callErrorOf, InstanceClosedError, InvalidCursorError, runCall } from "@chia1104/motoko-core";
import type { AgentInstance, StorageScope } from "@chia1104/motoko-core";
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
 * The connections Motoko serves, either the `Agent` itself or the `WebSockets` capability of a plain Durable Object.
 * Motoko reads the connections, their state and the SDK's readonly mark by the name each one gives it. The app's own
 * frames on them stay the app's.
 */
export type MotokoConnections = { getConnections(): Iterable<Connection> } & (
  | { isConnectionReadonly(connection: Connection): boolean }
  | { isReadonly(connection: Connection): boolean }
);

/** Decides whether `connection` may make `call`. A call it refuses is answered `forbidden` and runs nothing. */
export type MotokoAuthorize = (connection: Connection, call: MotokoCall) => boolean | Promise<boolean>;

const STATE_KEY = "motoko";

/** The most sessions one connection may follow. This keeps its state well inside the attachment's 2 KiB. */
export const MAX_SUBSCRIPTIONS = 8;

const followedSchema = z.record(z.string(), cursorSchema.nullable());

class RequestError extends Error {
  readonly code: MotokoErrorCode;
  constructor(code: MotokoErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function send(connection: Connection, frame: ServerFrame): boolean {
  if (connection.readyState !== WebSocket.OPEN) return false;
  try {
    connection.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function followedOf(connection: Connection): Record<string, Cursor | null> {
  const state: unknown = connection.state;
  if (typeof state !== "object" || state === null || !(STATE_KEY in state)) return {};
  const parsed = followedSchema.safeParse((state as Record<string, unknown>)[STATE_KEY]);
  return parsed.success ? parsed.data : {};
}

interface Reader {
  readonly stop: AbortController;
  cursor: Cursor | null;
}

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

  reattach(): void {
    for (const connection of this.#connections.getConnections()) {
      for (const [sessionId, cursor] of Object.entries(followedOf(connection))) {
        if (!this.#readersOf(connection).has(sessionId)) this.#follow(connection, sessionId, cursor);
      }
    }
  }

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

  closed(ws: WebSocket): void {
    // SAFETY: a connection is its WebSocket with the SDK's fields added, and the map is keyed by that one object.
    const connection = ws as Connection;
    for (const reader of this.#readers.get(connection)?.values() ?? []) reader.stop.abort();
    this.#readers.delete(connection);
  }

  dispose(): void {
    this.#disposed = true;
    for (const readers of this.#readers.values()) for (const reader of readers.values()) reader.stop.abort();
    this.#readers.clear();
  }

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
    const call = { method, params: parsed.data } as MotokoCall;
    const run = (allowed: boolean) => {
      if (connection.readyState !== WebSocket.OPEN) return;
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

  #isReadonly(connection: Connection): boolean {
    const connections = this.#connections;
    return "isConnectionReadonly" in connections
      ? connections.isConnectionReadonly(connection)
      : connections.isReadonly(connection);
  }

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

  #callErrorOf(error: unknown): CallError {
    const known = callErrorOf(error);
    if (known !== undefined) return known;
    this.#report(error);
    return { code: "internal", message: "Internal error" };
  }

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

  async #read(connection: Connection, sessionId: string, reader: Reader): Promise<void> {
    const { signal } = reader.stop;
    try {
      const endRead = closeAfterTwoEmptyReads(this.#instance().scope);
      for (;;) {
        const from = reader.cursor ?? undefined;
        const events = this.#instance()
          .session(sessionId)
          .events({ ...(from !== undefined && { from }), signal });
        let sent = false;
        for await (const { cursor, event } of events) {
          if (signal.aborted) return;
          if (!send(connection, { type: "motoko:event", sessionId, cursor, event })) return;
          sent = true;
          reader.cursor = cursor;
          this.#store(connection);
        }
        if (signal.aborted) return;
        endRead(sent);
      }
    } catch (error) {
      if (signal.aborted) return;
      this.#unfollow(connection, sessionId);
      send(connection, { type: "motoko:ended", sessionId, error: this.#callErrorOf(error) });
    }
  }

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
      // The attachment refused the state as too large together with the app's state. The follows then last only as
      // long as this isolate.
      this.#report(error);
    }
  }
}

function invalid(error: z.ZodError): MotokoErrorBody {
  return { code: "invalid_request", message: z.prettifyError(error) };
}

function closeAfterTwoEmptyReads(scope: StorageScope): (sent: boolean) => void {
  let lastWasEmpty = false;
  return (sent) => {
    if (!sent && lastWasEmpty) throw new InstanceClosedError(scope, "closed");
    lastWasEmpty = !sent;
  };
}
