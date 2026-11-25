import type { CallMethod, CallParams, Cursor } from "@chia1104/motoko-wire";
import { motokoFrame, serverFrameSchema } from "@chia1104/motoko-wire/socket";
import type { MotokoMethod, MotokoParams } from "@chia1104/motoko-wire/socket";

import { MotokoError } from "./client.ts";
import type { FollowListener, MotokoTransport } from "./client.ts";

const WEBSOCKET_OPEN = 1;

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

interface Pending {
  readonly frame: string;
  sent: boolean;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: MotokoError) => void;
}

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

class SocketTransport implements MotokoTransport {
  readonly #socket: MotokoSocket;
  readonly #calls = new Map<string, Pending>();
  readonly #follows = new Map<string, Follow>();
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
      if (this.#isOpen && follow.phase.kind !== "waiting") this.#send("unsubscribe", { sessionId }, ignore, ignore);
    };
  }

  get #isOpen(): boolean {
    return this.#socket.readyState === WEBSOCKET_OPEN;
  }

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
    if (this.#isOpen) call.sent = this.#trySend(call.frame);
    return id;
  }

  #trySend(frame: string): boolean {
    try {
      this.#socket.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  #subscribed(sessionId: string, follow: Follow, id: string): boolean {
    return this.#follows.get(sessionId) === follow && follow.phase.kind === "subscribing" && follow.phase.id === id;
  }

  #liveFollow(sessionId: string): Follow | undefined {
    const follow = this.#follows.get(sessionId);
    return follow?.phase.kind === "live" ? follow : undefined;
  }

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
    for (const call of this.#calls.values()) if (!call.sent) call.sent = this.#trySend(call.frame);
    for (const [sessionId, follow] of this.#follows) this.#subscribe(sessionId, follow);
  };

  readonly #onClose = () => {
    for (const follow of this.#follows.values()) {
      const wasLive = follow.phase.kind === "live";
      follow.phase = WAITING;
      if (wasLive) follow.listener.dropped();
    }
    for (const [id, call] of this.#calls) {
      if (!call.sent) continue;
      this.#calls.delete(id);
      call.reject(closed());
    }
  };

  readonly #onMessage = (event: Event) => {
    const raw = motokoFrame("data" in event ? event.data : undefined);
    if (raw === undefined) return;
    const parsed = serverFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.type) {
      case "motoko:event":
      case "motoko:ended": {
        const follow = this.#liveFollow(frame.sessionId);
        if (follow === undefined) return;
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

const transports = new WeakMap<MotokoSocket, SocketTransport>();

/**
 * Motoko's socket protocol over `socket`, which is the Agents SDK's `AgentClient`, the socket `useAgent` returns, or any
 * WebSocket to a Durable Object that serves the protocol, such as one with `@chia1104/motoko-cloudflare`'s
 * `MotokoCapability`. Made at first use and shared by everyone who asks for the same socket.
 */
export function webSocketTransport(socket: MotokoSocket): MotokoTransport {
  let transport = transports.get(socket);
  if (transport === undefined) {
    transport = new SocketTransport(socket);
    transports.set(socket, transport);
  }
  return transport;
}
