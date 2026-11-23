import type { CallMethod, CallParams, Cursor } from "@chia1104/motoko-wire";
import { motokoFrame, serverFrameSchema } from "@chia1104/motoko-wire/socket";
import type { MotokoMethod, MotokoParams } from "@chia1104/motoko-wire/socket";

import { MotokoError } from "./client.ts";
import type { FollowListener, MotokoTransport } from "./client.ts";

/** `WebSocket.OPEN`. */
const OPEN = 1;

/** An `Event` listener, as every EventTarget takes one: the `message` one reads `data` off its `MessageEvent`. */
type SocketListener = (event: Event) => void;

/**
 * The socket the transport talks over. `AgentClient` and `useAgent`'s socket reconnect on their own and fire `open`
 * again; a plain WebSocket opens once.
 */
export interface MotokoSocket {
  readonly readyState: number;
  send(data: string): void;
  addEventListener(type: "open" | "close" | "message", listener: SocketListener): void;
  removeEventListener(type: "open" | "close" | "message", listener: SocketListener): void;
}

/** A call: queued until the socket is open, then sent and waiting for its reply. */
interface Pending {
  readonly frame: string;
  sent: boolean;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: MotokoError) => void;
}

/**
 * Where a follow is on the socket: waiting for it to open, its subscribe sent and unanswered (an event or an end before
 * the result belongs to an earlier follow, and is dropped), or live.
 */
type Phase =
  | { readonly kind: "waiting" }
  | { readonly kind: "subscribing"; readonly id: string }
  | { readonly kind: "live" };

const WAITING: Phase = { kind: "waiting" };
const LIVE: Phase = { kind: "live" };

interface Follow {
  readonly from: () => Cursor | undefined;
  readonly listener: FollowListener;
  phase: Phase;
}

/**
 * Motoko's socket protocol (`@chia1104/motoko-wire/socket`) over one socket: `motoko:` frames, beside the SDK's and the
 * app's. Calls made while the socket is closed go out once it opens; a new connection follows nothing, so on every
 * `open` each follow subscribes again, from the client's cursor.
 */
class SocketTransport implements MotokoTransport {
  readonly #socket: MotokoSocket;
  readonly #calls = new Map<string, Pending>();
  /** The follows the socket carries, by session; one that ended or stopped is gone from here. */
  readonly #follows = new Map<string, Follow>();
  /** Call ids need only be unique on one socket, and a socket has one transport. */
  #nextId = 0;

  constructor(socket: MotokoSocket) {
    this.#socket = socket;
    socket.addEventListener("open", this.#onOpen);
    socket.addEventListener("close", this.#onClose);
    socket.addEventListener("message", this.#onMessage);
  }

  call<M extends CallMethod>(method: M, params: CallParams<M>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(closed());
    return new Promise((resolve, reject) => {
      // Its reply or the abort, whichever comes first, takes it out of `#calls` and settles it.
      const abort = () => {
        if (this.#calls.delete(id)) reject(closed());
      };
      const id = this.#send(
        method,
        params,
        (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  follow(sessionId: string, from: () => Cursor | undefined, listener: FollowListener): () => void {
    const follow: Follow = { from, listener, phase: WAITING };
    this.#follows.set(sessionId, follow);
    if (this.#isOpen) this.#subscribe(sessionId, follow);
    return () => {
      if (this.#follows.get(sessionId) !== follow) return;
      this.#follows.delete(sessionId);
      // A follow still waiting for the socket was never subscribed on this connection.
      if (this.#isOpen && follow.phase.kind !== "waiting") this.#send("unsubscribe", { sessionId }, ignore, ignore);
    };
  }

  get #isOpen(): boolean {
    return this.#socket.readyState === OPEN;
  }

  /** Sends a call now if the socket is open, else once it opens; its reply settles it as it arrives. */
  #send<M extends MotokoMethod>(
    method: M,
    params: MotokoParams<M>,
    resolve: (result: unknown) => void,
    reject: (error: MotokoError) => void,
  ): string {
    this.#nextId += 1;
    const id = String(this.#nextId);
    const call: Pending = {
      frame: JSON.stringify({ type: "motoko:call", id, method, params }),
      sent: false,
      resolve,
      reject,
    };
    this.#calls.set(id, call);
    if (this.#isOpen) this.#transmit(call);
    return id;
  }

  #transmit(call: Pending) {
    try {
      this.#socket.send(call.frame);
      call.sent = true;
    } catch {
      // The socket closed under the send: the call waits for the next open.
    }
  }

  /** The follow is still the session's, at the subscribe `id` it sent. */
  #subscribed(sessionId: string, follow: Follow, id: string): boolean {
    return this.#follows.get(sessionId) === follow && follow.phase.kind === "subscribing" && follow.phase.id === id;
  }

  /**
   * Asks the server to follow the session from the client's cursor. Its reply settles the follow as it arrives, not a
   * microtask later, so the event frame right behind it is the follow's.
   */
  #subscribe(sessionId: string, follow: Follow) {
    const cursor = follow.from();
    const id = this.#send(
      "subscribe",
      { sessionId, ...(cursor !== undefined && { from: cursor }) },
      () => {
        if (!this.#subscribed(sessionId, follow, id)) return;
        follow.phase = LIVE;
        follow.listener.live();
      },
      (error) => {
        if (!this.#subscribed(sessionId, follow, id)) return;
        this.#follows.delete(sessionId);
        follow.listener.ended(error);
      },
    );
    follow.phase = { kind: "subscribing", id };
  }

  readonly #onOpen = () => {
    for (const call of this.#calls.values()) if (!call.sent) this.#transmit(call);
    for (const [sessionId, follow] of this.#follows) this.#subscribe(sessionId, follow);
  };

  readonly #onClose = () => {
    // The connection's follows are gone with it, so a subscribe it cut off settles nothing.
    for (const follow of this.#follows.values()) {
      const wasLive = follow.phase.kind === "live";
      follow.phase = WAITING;
      if (wasLive) follow.listener.dropped();
    }
    // A call sent on this connection gets no reply; one still queued goes out on the next.
    for (const [id, call] of this.#calls) {
      if (!call.sent) continue;
      this.#calls.delete(id);
      call.reject(closed());
    }
  };

  readonly #onMessage = (event: Event) => {
    // SAFETY: the socket dispatches a `MessageEvent` to `message` listeners.
    const raw = motokoFrame((event as MessageEvent).data);
    if (raw === undefined) return;
    const parsed = serverFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.type) {
      case "motoko:event":
      case "motoko:ended": {
        const follow = this.#follows.get(frame.sessionId);
        if (follow?.phase.kind !== "live") return;
        if (frame.type === "motoko:event") {
          follow.listener.event({ cursor: frame.cursor, event: frame.event });
        } else {
          this.#follows.delete(frame.sessionId);
          follow.listener.ended(new MotokoError(frame.error.code, frame.error.message));
        }
        return;
      }
      case "motoko:result":
      case "motoko:error": {
        const call = this.#calls.get(frame.id);
        if (call === undefined) return;
        this.#calls.delete(frame.id);
        if (frame.type === "motoko:error") call.reject(new MotokoError(frame.error.code, frame.error.message));
        else call.resolve(frame.result);
        return;
      }
      default: {
        const exhaustive: never = frame;
        return exhaustive;
      }
    }
  };
}

const closed = () => new MotokoError("connection_closed", "The connection closed before the reply came");
const ignore = () => undefined;

/** One transport per socket, so one client per socket: a session is followed once on a connection. */
const transports = new WeakMap<MotokoSocket, SocketTransport>();

/**
 * Motoko's socket protocol over `socket`: the Agents SDK's `AgentClient`, the socket `useAgent` returns, or any
 * WebSocket to a Durable Object that serves it (`@chia1104/motoko-cloudflare`'s `MotokoCapability`). Made at first use
 * and shared by everyone who asks for the same socket.
 */
export function webSocketTransport(socket: MotokoSocket): MotokoTransport {
  let transport = transports.get(socket);
  if (transport === undefined) {
    transport = new SocketTransport(socket);
    transports.set(socket, transport);
  }
  return transport;
}
