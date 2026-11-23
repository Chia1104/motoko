import * as z from "zod";

import { callErrorOf, InstanceClosedError, runCall, SessionNotFoundError } from "@chia1104/motoko-core";
import type { AgentDefinition, AgentInstance, AgentRuntime } from "@chia1104/motoko-core";
import { LeaseHeldError } from "@chia1104/motoko-core/store";
import { callSchemas, cursorSchema, decodeCursor, sessionIdSchema } from "@chia1104/motoko-wire";
import type { Call, CallError, CallErrorCode, CallMethod, Cursor } from "@chia1104/motoko-wire";

import { forwarder } from "./forward.ts";
import type { ClusterOptions } from "./forward.ts";

/**
 * The call protocol of `@chia1104/motoko-wire` over HTTP, as one Fetch handler the app mounts under a base path: a call
 * is a JSON request, and following a session is a request answered with its wire events as server-sent events.
 */

/** The instance a request is for, as `resolve` answers it; anything else of the app's on it reaches `authorize`. */
export interface MotokoTarget {
  readonly agent: AgentDefinition | string;
  readonly name: string;
}

/** Following a session's events after `from` (default: from its start), which `GET .../events` asks. */
export interface FollowCall {
  readonly method: "follow";
  readonly params: { readonly sessionId: string; readonly from?: Cursor };
}

/** What a request asks of its instance, as `authorize` decides on it: one of the protocol's calls, or a follow. */
export type HttpCall = Call | FollowCall;

export interface MotokoHandlerOptions<T extends MotokoTarget> {
  /** The path the routes are under, such as `/motoko`. Default: the root. */
  readonly basePath?: string;
  /**
   * The instance `request` is for. It is where the app authenticates: a `Response` it answers (a 401, say) is sent as
   * it is, and nothing runs.
   */
  readonly resolve: (request: Request) => T | Response | Promise<T | Response>;
  /** Decides whether `request` may make `call`; one it refuses is answered `forbidden` and runs nothing. */
  readonly authorize?: (request: Request, call: HttpCall, target: T) => boolean | Promise<boolean>;
  /** An error that is not the runtime's, such as a throw of `resolve`: its request is answered `internal`. */
  readonly onError?: (error: unknown) => void;
  /** How often a follow sends a comment line, in ms, so proxies keep a quiet stream open. Default: 15 000. */
  readonly heartbeatMs?: number;
  /** The most bytes of a call's body the handler reads; a longer one is answered 413. Default: 1 MiB. */
  readonly maxBodyBytes?: number;
  /**
   * Experimental. This node's place in a cluster of nodes on one shared-database store: a request whose instance
   * cannot open here because a peer holds its lease is forwarded to that peer, its home.
   */
  readonly cluster?: ClusterOptions;
}

/** The status each call error is answered with. */
const STATUS = {
  invalid_request: 400,
  invalid_cursor: 400,
  forbidden: 403,
  session_not_found: 404,
  session_busy: 409,
  session_owned: 409,
  approval_not_pending: 409,
  reply_not_pending: 409,
  internal: 500,
  instance_closed: 503,
  lease_held: 503,
} as const satisfies Record<CallErrorCode, number>;

type Route = { readonly kind: "call" } | { readonly kind: "follow"; readonly segment: string };

/** The HTTP method of each route. */
const ROUTE_METHODS = { call: "POST", follow: "GET" } as const;

const FOLLOW_PATH = /^\/sessions\/([^/]+)\/events$/;

const METHODS = Object.keys(callSchemas) as [CallMethod, ...CallMethod[]];
const callBodySchema = z.object({ method: z.enum(METHODS), params: z.unknown() });

const INTERNAL: CallError = { code: "internal", message: "Internal error" };

const EVENT_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  // nginx buffers a response unless told not to, which holds events back.
  "x-accel-buffering": "no",
};

const encoder = new TextEncoder();
const HEARTBEAT = ": heartbeat\n\n";

/**
 * Motoko's routes under `basePath` as a Fetch handler, for any framework that speaks `Request` and `Response`, or Node's
 * `http` through `nodeListener`:
 *
 * - `POST {basePath}/call`, a JSON `{ method, params }` of `callSchemas`, answered `{ result }` or `{ error }`;
 * - `GET {basePath}/sessions/:sessionId/events`, answered with the session's wire events as server-sent events, after
 *   the cursor in `Last-Event-ID` or, without one, the `from` query parameter.
 */
export function motokoHandler<T extends MotokoTarget>(
  runtime: AgentRuntime,
  options: MotokoHandlerOptions<T>,
): (request: Request) => Promise<Response> {
  const basePath = options.basePath?.replace(/\/+$/, "") ?? "";
  if (basePath !== "" && !basePath.startsWith("/")) throw new TypeError("`basePath` starts with a `/`");
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const forward = options.cluster === undefined ? undefined : forwarder(options.cluster);

  /** Core's errors by their code; anything else is not the client's to read, so it is reported. */
  const errorOf = (error: unknown): CallError => {
    const known = callErrorOf(error);
    if (known !== undefined) return known;
    options.onError?.(error);
    return INTERNAL;
  };

  const allowed = async (request: Request, call: HttpCall, target: T) =>
    options.authorize === undefined || (await options.authorize(request, call, target)) === true;

  const instanceOf = (target: T) => runtime.get(target.agent, target.name);

  /**
   * What `serve` answers, unless the instance cannot open here because another node holds its lease. In a cluster the
   * request then goes to that node, its home, with `body`; one it does not go to, or that cannot reach the home, is
   * answered 503 `lease_held`.
   */
  async function served(request: Request, body: string | undefined, serve: () => Promise<Response>) {
    try {
      return await serve();
    } catch (error) {
      if (forward === undefined || !(error instanceof LeaseHeldError)) throw error;
      const { pathname, search } = new URL(request.url);
      return (await forward(error, request, pathname.slice(basePath.length) + search, body)) ?? leaseHeld(error);
    }
  }

  async function answer(request: Request, target: T): Promise<Response> {
    const read = await callOf(request, maxBodyBytes);
    if (read instanceof Response) return read;
    const { call, body } = read;
    if (!(await allowed(request, call, target))) return forbidden(call.method);
    return served(request, body, async () => Response.json({ result: await runCall(instanceOf(target), call) }));
  }

  async function follow(request: Request, url: URL, target: T, segment: string): Promise<Response> {
    const sessionId = sessionIdOf(segment);
    if (sessionId === undefined) return failure({ code: "invalid_request", message: "Not a session id" });
    const from = cursorOf(request, url, sessionId);
    if (from instanceof Response) return from;
    const call: FollowCall = { method: "follow", params: { sessionId, ...(from !== undefined && { from }) } };
    if (!(await allowed(request, call, target))) return forbidden(call.method);
    return served(request, undefined, async () => {
      // Before the stream starts, so a session that is gone, or an instance that cannot open here, is answered with
      // its status: EventSource reconnects after a stream ends, but not after a refusal.
      const instance = instanceOf(target);
      const sessions = await instance.listSessions();
      if (!sessions.some(({ id }) => id === sessionId)) throw new SessionNotFoundError(sessionId);
      const stop = new AbortController();
      const signal = AbortSignal.any([request.signal, stop.signal]);
      const frames = framesOf(instance, sessionId, from, signal, errorOf);
      return new Response(eventStream(frames, signal, stop, heartbeatMs), { headers: EVENT_STREAM_HEADERS });
    });
  }

  return async (request) => {
    try {
      const url = new URL(request.url);
      const route = routeOf(url.pathname, basePath);
      if (route === undefined) return failure({ code: "invalid_request", message: "No such route" }, 404);
      const method = ROUTE_METHODS[route.kind];
      if (request.method !== method) {
        return failure({ code: "invalid_request", message: `This route takes ${method}` }, 405, { allow: method });
      }
      const target = await options.resolve(request);
      if (target instanceof Response) return target;
      return route.kind === "call" ? await answer(request, target) : await follow(request, url, target, route.segment);
    } catch (error) {
      return failure(errorOf(error));
    }
  };
}

function routeOf(pathname: string, basePath: string): Route | undefined {
  if (!pathname.startsWith(basePath)) return undefined;
  const path = pathname.slice(basePath.length);
  if (path === "/call") return { kind: "call" };
  const segment = FOLLOW_PATH.exec(path)?.[1];
  return segment === undefined ? undefined : { kind: "follow", segment };
}

function failure(error: CallError, status: number = STATUS[error.code], headers?: Record<string, string>): Response {
  return Response.json({ error }, { status, ...(headers !== undefined && { headers }) });
}

const forbidden = (method: HttpCall["method"]) =>
  failure({ code: "forbidden", message: `This request may not ${method}` });

/**
 * 503 `lease_held`, with `Retry-After` when the store says when the lease expires: the earliest a retry can take the
 * instance over, as the holder last renewed the lease, by this node's clock against the database's.
 */
function leaseHeld(error: LeaseHeldError): Response {
  const { expiresAt } = error;
  const seconds =
    expiresAt === undefined ? undefined : Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  return failure(
    { code: "lease_held", message: error.message },
    503,
    seconds === undefined ? undefined : { "retry-after": String(seconds) },
  );
}

function invalid(error: z.ZodError): Response {
  return failure({ code: "invalid_request", message: z.prettifyError(error) });
}

/** The call a request's body sends, with the body as it came, or the refusal of one that is not a call. */
async function callOf(request: Request, maxBytes: number): Promise<{ call: Call; body: string } | Response> {
  // Only JSON: a cross-site form cannot send it without the browser asking the server first (CORS).
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return failure({ code: "invalid_request", message: "A call's body is application/json" }, 415);
  }
  let text: string | undefined;
  let json: unknown;
  try {
    text = await textOf(request, maxBytes);
    if (text === undefined) {
      return failure({ code: "invalid_request", message: `A call's body is at most ${maxBytes} bytes` }, 413);
    }
    json = JSON.parse(text);
  } catch {
    return failure({ code: "invalid_request", message: "The body is not JSON" });
  }
  const parsed = callBodySchema.safeParse(json);
  if (!parsed.success) return invalid(parsed.error);
  const { method } = parsed.data;
  const params = callSchemas[method].params.safeParse(parsed.data.params);
  if (!params.success) return invalid(params.error);
  // SAFETY: `params` is `method`'s, parsed with its own schema.
  return { call: { method, params: params.data } as Call, body: text };
}

/**
 * The request's body as text, or `undefined` once it is longer than `maxBytes`, as it declares or as it streams. Then
 * the body is cancelled, and nothing more of it is read.
 */
async function textOf(request: Request, maxBytes: number): Promise<string | undefined> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const tooLong = () => {
    void reader.cancel().catch(() => undefined);
    return undefined;
  };
  if (Number(request.headers.get("content-length")) > maxBytes) return tooLong();
  const decoder = new TextDecoder();
  let text = "";
  for (let size = 0; ;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > maxBytes) return tooLong();
    text += decoder.decode(value, { stream: true });
  }
}

function sessionIdOf(segment: string): string | undefined {
  try {
    const parsed = sessionIdSchema.safeParse(decodeURIComponent(segment));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // A malformed escape.
    return undefined;
  }
}

/**
 * The cursor a follow resumes after: `Last-Event-ID`, which EventSource sends when it reconnects, else the `from` query
 * parameter, which a client sets for its first connection. Anything but a cursor of the session is refused.
 */
function cursorOf(request: Request, url: URL, sessionId: string): Cursor | undefined | Response {
  const raw = request.headers.get("last-event-id") || url.searchParams.get("from") || undefined;
  if (raw === undefined) return undefined;
  const cursor = cursorSchema.safeParse(raw);
  if (cursor.success && decodeCursor(cursor.data)?.session === sessionId) return cursor.data;
  return failure({ code: "invalid_cursor", message: `Not a cursor of session ${sessionId}` });
}

/**
 * The session's events after `from` as server-sent events, until `signal` aborts. A stream that ends with the client
 * still there is read again from where it stopped, which says why it ended. A deleted session fails then, and the
 * follow ends with an `ended` event. An instance that closed (the server is shutting down, or lost the lease) fails
 * too, and the stream ends without one: the client reconnects after its last cursor, and whatever serves the instance
 * then answers it. Two reads in a row that end with nothing sent count as that.
 */
async function* framesOf(
  instance: AgentInstance,
  sessionId: string,
  from: Cursor | undefined,
  signal: AbortSignal,
  errorOf: (error: unknown) => CallError,
): AsyncGenerator<string, void, undefined> {
  let cursor = from;
  try {
    for (let retried = false; ;) {
      const events = instance.session(sessionId).events({ ...(cursor !== undefined && { from: cursor }), signal });
      let sent = false;
      for await (const item of events) {
        if (signal.aborted) return;
        yield `id: ${item.cursor}\ndata: ${JSON.stringify({ sessionId, cursor: item.cursor, event: item.event })}\n\n`;
        sent = true;
        cursor = item.cursor;
      }
      if (signal.aborted) return;
      if (!sent && retried) throw new InstanceClosedError(instance.scope, "closed");
      retried = !sent;
    }
  } catch (error) {
    if (signal.aborted || error instanceof InstanceClosedError) return;
    yield `event: ended\ndata: ${JSON.stringify({ sessionId, error: errorOf(error) })}\n\n`;
  }
}

/**
 * `frames` as a response body, read only as fast as the client takes them, with a heartbeat comment every
 * `heartbeatMs`. Once `signal` aborts (the client went away, or the body was cancelled), the reader stops wherever it
 * is, so the instance can close once idle.
 */
function eventStream(
  frames: AsyncGenerator<string, void, undefined>,
  signal: AbortSignal,
  stop: AbortController,
  heartbeatMs: number,
): ReadableStream<Uint8Array> {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(heartbeat);
      void frames.return(undefined);
    },
    { once: true },
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      heartbeat = setInterval(() => {
        // Nothing piles up for a client that is not reading.
        if ((controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(HEARTBEAT));
      }, heartbeatMs);
    },
    async pull(controller) {
      const next = await frames.next();
      if (cancelled) return;
      if (next.done === true) {
        clearInterval(heartbeat);
        controller.close();
      } else {
        controller.enqueue(encoder.encode(next.value));
      }
    },
    cancel() {
      cancelled = true;
      stop.abort();
    },
  });
}
