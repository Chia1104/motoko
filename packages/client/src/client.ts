import { applyEvent, callSchemas, emptySessionView } from "@chia1104/motoko-wire";
import type { AgentSessionView, CallMethod, CallParams, CallResult, Cursor, StreamItem } from "@chia1104/motoko-wire";
import type { MotokoErrorCode } from "@chia1104/motoko-wire/socket";

export type SessionInfo = CallResult<"createSession">;
export type CreateSessionOptions = CallParams<"createSession">;
export type SubmitInput = Omit<CallParams<"submit">, "sessionId">;
export type SubmitResult = CallResult<"submit">;
export type ApprovalDecision = CallParams<"approve">["decisions"][number];
export type ApprovalOutcome = CallResult<"approve">[number];
export type ReplyInput = Omit<CallParams<"reply">, "sessionId">;
export type ReplyResult = CallResult<"reply">;
export type WithdrawResult = CallResult<"withdraw">;

/**
 * A call the server refused, a follow it ended, or a call whose reply can never come: `connection_closed`, sent but
 * not answered, so it may or may not have run.
 */
export class MotokoError extends Error {
  override readonly name = "MotokoError";
  readonly code: MotokoErrorCode | "connection_closed";
  constructor(code: MotokoErrorCode | "connection_closed", message: string) {
    super(message);
    this.code = code;
  }
}

/** What a transport tells the client of one session it follows. */
export interface FollowListener {
  /** The follow is on: the events that come next are the session's after the cursor `from()` gave. Again after each drop. */
  readonly live: () => void;
  readonly event: (item: StreamItem) => void;
  /** The server stopped following the session, as `error` says why; nothing more comes. */
  readonly ended: (error: MotokoError) => void;
  /** The connection dropped; the transport follows again, from `from()`, once it can. */
  readonly dropped: () => void;
}

/**
 * How calls and a session's events travel between the client and an instance's home. A transport owns its wire format
 * and its reconnects; the client owns the rest (each followed session's view, its cursor and its status, and the calls'
 * results), so every transport carries the same client.
 */
export interface MotokoTransport {
  /**
   * Sends one call: resolves with its result as the server answered it, which the client parses, or rejects with a
   * `MotokoError`. Once `signal` aborts, the call rejects with `connection_closed`, and is not sent if it was not yet.
   */
  call<M extends CallMethod>(method: M, params: CallParams<M>, signal: AbortSignal): Promise<unknown>;
  /**
   * Follows a session from `from()`, which it asks again for each reconnect, telling `listener` what happens until
   * the returned function stops it. After `ended`, or once stopped, it tells `listener` nothing more. It throws only
   * before it has told `listener` anything, and the client's `follow` then throws its error; a follow it cannot keep
   * once it has told `listener` something ends with `ended`.
   */
  follow(sessionId: string, from: () => Cursor | undefined, listener: FollowListener): () => void;
}

/**
 * Where a followed session is: `connecting` until the server confirms the follow, again after each drop; `live`
 * while its events arrive; `ended` once the server stopped following it, as `error` says why.
 */
export type MotokoSessionStatus = "connecting" | "live" | "ended";

export interface MotokoSessionState {
  readonly view: AgentSessionView;
  /** The cursor right after the last event folded; a reconnect resumes from it. */
  readonly cursor?: Cursor;
  readonly status: MotokoSessionStatus;
  readonly error?: MotokoError;
}

export interface MotokoClient {
  /**
   * Follows a session: `listener` hears each new state until the returned function is called. Every follower of a
   * session shares one follow. Once the last one leaves, the follow is kept, with its state, for five seconds before
   * it stops: a follower who comes back meanwhile (a remounted component) picks it up where it is instead of replaying
   * the session. A follow the server ended is not kept. A listener that throws is reported as uncaught, as an
   * `EventTarget`'s listener is, and the others still hear the state.
   */
  follow(sessionId: string, listener: (state: MotokoSessionState) => void): () => void;
  /**
   * The state of a session followed, or kept since its last follower left; for any other, an empty view, `connecting`.
   * Unchanged, the same object.
   */
  sessionState(sessionId: string): MotokoSessionState;
  /**
   * Idempotent by `requestId`, a fresh one by default: after `connection_closed`, create again with the same one to get
   * the session the first call made, if it made one.
   */
  createSession(options?: CreateSessionOptions): Promise<SessionInfo>;
  /** Oldest first. */
  listSessions(): Promise<SessionInfo[]>;
  /**
   * Idempotent by `requestId`: submitting one again returns the first submission. While a run is going, `whenBusy`
   * says what the input does: `queue` (default) waits for the run's answer, `steer` joins the run after its current
   * tool round, `reject` refuses it (`session_busy`). A waiting input shows in the view's `queued`.
   */
  submit(sessionId: string, input: SubmitInput): Promise<SubmitResult>;
  /**
   * Takes back an input still waiting in the queue, by its `submissionId`: `withdrawn`, else `already_placed` (a run
   * took it first) or `settled`. Safe to send again. An ask's input, or one the session does not hold, rejects with
   * `invalid_request`.
   */
  withdraw(sessionId: string, submissionId: string): Promise<WithdrawResult>;
  /** All the decisions are applied, or none is (`approval_not_pending`). */
  approve(sessionId: string, decisions: readonly ApprovalDecision[]): Promise<ApprovalOutcome[]>;
  /**
   * Replies to a deferred call of the session with its reply address's token. Safe to send again: a second reply is
   * `already_replied`. A call that waits for no such reply rejects with `reply_not_pending`.
   */
  reply(sessionId: string, input: ReplyInput): Promise<ReplyResult>;
  abort(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** Leaves the transport: pending calls reject with `connection_closed`, and the follows stop. */
  close(): void;
}

const NOT_FOLLOWED: MotokoSessionState = Object.freeze({ view: emptySessionView(), status: "connecting" });

/** How long a follow is kept once its last follower leaves, for one who comes back, as a remounted component does. */
const LINGER_MS = 5_000;

interface Follow {
  state: MotokoSessionState;
  /** One entry per `follow` call, so a leave removes its own, even when two follows of the session share a listener. */
  readonly listeners: Set<(state: MotokoSessionState) => void>;
  stop: () => void;
  /** While the follow is kept with nobody following it, the timer that drops it. */
  linger?: ReturnType<typeof setTimeout>;
}

class TransportClient implements MotokoClient {
  readonly #transport: MotokoTransport;
  readonly #follows = new Map<string, Follow>();
  /** Aborts every call of this client when it closes. */
  readonly #closing = new AbortController();

  constructor(transport: MotokoTransport) {
    this.#transport = transport;
  }

  follow(sessionId: string, listener: (state: MotokoSessionState) => void): () => void {
    const entry = (state: MotokoSessionState) => listener(state);
    let follow = this.#follows.get(sessionId);
    if (follow === undefined) {
      follow = { state: NOT_FOLLOWED, listeners: new Set([entry]), stop: () => undefined };
      this.#follows.set(sessionId, follow);
      try {
        this.#start(sessionId, follow);
      } catch (error) {
        if (this.#follows.get(sessionId) === follow) this.#follows.delete(sessionId);
        throw error;
      }
    } else {
      clearTimeout(follow.linger);
      follow.listeners.add(entry);
    }
    const followed = follow;
    return () => {
      if (!followed.listeners.delete(entry) || followed.listeners.size > 0) return;
      if (this.#follows.get(sessionId) !== followed) return;
      if (followed.state.status === "ended") this.#drop(sessionId, followed);
      else followed.linger = setTimeout(() => this.#drop(sessionId, followed), LINGER_MS);
    };
  }

  sessionState(sessionId: string): MotokoSessionState {
    return this.#follows.get(sessionId)?.state ?? NOT_FOLLOWED;
  }

  createSession(options?: CreateSessionOptions): Promise<SessionInfo> {
    return this.#call("createSession", { requestId: options?.requestId ?? crypto.randomUUID() });
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.#call("listSessions", {});
  }

  submit(sessionId: string, input: SubmitInput): Promise<SubmitResult> {
    return this.#call("submit", { sessionId, ...input });
  }

  withdraw(sessionId: string, submissionId: string): Promise<WithdrawResult> {
    return this.#call("withdraw", { sessionId, submissionId });
  }

  approve(sessionId: string, decisions: readonly ApprovalDecision[]): Promise<ApprovalOutcome[]> {
    return this.#call("approve", { sessionId, decisions: [...decisions] });
  }

  reply(sessionId: string, input: ReplyInput): Promise<ReplyResult> {
    return this.#call("reply", { sessionId, ...input });
  }

  async abort(sessionId: string): Promise<void> {
    await this.#call("abort", { sessionId });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#call("deleteSession", { sessionId });
  }

  close(): void {
    if (clients.get(this.#transport) === this) clients.delete(this.#transport);
    this.#closing.abort();
    for (const follow of this.#follows.values()) {
      clearTimeout(follow.linger);
      follow.stop();
    }
    this.#follows.clear();
  }

  /** Forgets the session's follow and stops it. */
  #drop(sessionId: string, follow: Follow) {
    clearTimeout(follow.linger);
    this.#follows.delete(sessionId);
    follow.stop();
  }

  /**
   * Follows the session over the transport, folding `follow`'s state from what it tells. A follow that is no longer
   * the session's once the transport has started it, as the client closed meanwhile, stops at once.
   */
  #start(sessionId: string, follow: Follow) {
    const update = (change: Partial<MotokoSessionState>) => {
      follow.state = { ...follow.state, ...change };
      for (const listener of [...follow.listeners]) {
        try {
          listener(follow.state);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    };
    const stop = this.#transport.follow(sessionId, () => follow.state.cursor, {
      live: () => update({ status: "live" }),
      event: ({ cursor, event }) => update({ view: applyEvent(follow.state.view, event), cursor }),
      ended: (error) => {
        update({ status: "ended", error });
        if (follow.listeners.size === 0 && this.#follows.get(sessionId) === follow) this.#drop(sessionId, follow);
      },
      dropped: () => update({ status: "connecting" }),
    });
    if (this.#follows.get(sessionId) === follow) follow.stop = stop;
    else stop();
  }

  async #call<M extends CallMethod>(method: M, params: CallParams<M>): Promise<CallResult<M>> {
    const answer = await this.#transport.call(method, params, this.#closing.signal);
    const result = callSchemas[method].result.safeParse(answer);
    if (!result.success) throw new MotokoError("internal", `Malformed result of ${method}`);
    // SAFETY: parsed with `method`'s own result schema.
    return result.data as CallResult<M>;
  }
}

/** One client per transport: two would follow a session twice over one socket, each restarting the other's follow. */
const clients = new WeakMap<MotokoTransport, TransportClient>();

/**
 * The transport's Motoko client, made at first use and shared by everyone who asks for the same transport:
 * `motokoClient(webSocketTransport(socket))` or `motokoClient(httpTransport({ baseUrl }))`.
 */
export function motokoClient(transport: MotokoTransport): MotokoClient {
  let client = clients.get(transport);
  if (client === undefined) {
    client = new TransportClient(transport);
    clients.set(transport, client);
  }
  return client;
}
