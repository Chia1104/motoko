import { request as httpRequest } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

import type { LeaseHeldError } from "@chia1104/motoko-core/store";

/**
 * Experimental: one node of a cluster whose nodes share one database store. Each instance is served by its home, the
 * node that holds its lease, and the store's lease row names that node: its `holder` is the node's internal URL.
 */
export interface ClusterOptions {
  /**
   * This node's internal base URL, where its peers reach its routes, such as `http://10.0.0.7:3000/motoko`. The
   * store's leases name it as their holder, so the store's `holder` option is this same string.
   */
  readonly self: string;
  /**
   * The holders this node may forward to: their base URLs, or a predicate of one. A forward carries the caller's
   * credentials, so a holder read from the database gets a request only when the app names it one of its own nodes.
   */
  readonly peers: readonly string[] | ((holder: string) => boolean);
  /** How long a forward waits to connect to the home before it answers 503 `lease_held`. Default: 2 000 ms. */
  readonly connectTimeoutMs?: number;
}

/** The header a forward sets, naming the node that sent it. A request that carries it is never forwarded again. */
export const FORWARDED_BY = "motoko-forwarded-by";

/**
 * Sends a request whose instance's open `error` refused to the instance's home. `path` is the request's path below the
 * base, with its query, and `body` the call's body as the handler read it. Resolves the home's answer, or `undefined`
 * when the request is not forwarded or the home cannot be reached; then the handler answers 503 `lease_held`.
 */
export type Forward = (
  error: LeaseHeldError,
  request: Request,
  path: string,
  body: string | undefined,
) => Promise<Response | undefined>;

/** Headers of one connection rather than of the message: a forward neither sends them on nor passes them back. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers of the request that its own connection sets again: where it goes, and how long its body is. */
const SET_AGAIN = new Set(["host", "content-length", "expect"]);

/** The statuses whose answer has no body. */
const NULL_BODY = new Set([204, 205, 304]);

const isHttp = (url: URL | null): url is URL => url?.protocol === "http:" || url?.protocol === "https:";

/** The forward of a node with `options`, which it validates. */
export function forwarder(options: ClusterOptions): Forward {
  const { self, peers } = options;
  if (!isHttp(URL.parse(self))) throw new TypeError("`cluster.self` is an http(s) URL");
  const isPeer = typeof peers === "function" ? peers : (holder: string) => peers.includes(holder);
  const connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
  if (!(Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0)) {
    throw new TypeError("`cluster.connectTimeoutMs` must be a positive number of milliseconds");
  }

  return async (error, request, path, body) => {
    // A node that believed this one the home sent it, so the lease moved meanwhile: the client tries again.
    if (request.headers.has(FORWARDED_BY)) return undefined;
    const { holder } = error;
    // This node's own lease, from a process before this one: it frees once it expires.
    if (holder === undefined || holder === self) return undefined;
    if (isPeer(holder) !== true) return undefined;
    const home = URL.parse(`${holder.replace(/\/+$/, "")}${path}`);
    if (!isHttp(home)) return undefined;
    return send(home, request, body, self, connectTimeoutMs);
  };
}

/**
 * `request`'s method and headers, with `body`, sent to `url` on a connection of its own. Resolves `undefined` when no
 * connection was made within `connectTimeoutMs`, so the home never got the request. Otherwise it resolves the home's
 * answer as it streams. A connection cut before the answer came is a 502 whose body breaks off, as the home's own
 * answer would have: the call may or may not have run.
 */
function send(
  url: URL,
  request: Request,
  body: string | undefined,
  self: string,
  connectTimeoutMs: number,
): Promise<Response | undefined> {
  return new Promise((resolve) => {
    const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: request.method,
      headers: headersOf(request.headers, self, body),
      // Never a pooled socket: one the home dropped meanwhile would fail after the request was written, so a home that
      // is gone would look like one that cut the call off. A fresh connection fails before anything is sent.
      agent: false,
    });
    let connected = false;
    let failure: unknown;
    // The client went away or stopped reading: the home's request ends too, which frees the home's reader.
    const abort = () => void upstream.destroy();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(
      () => upstream.destroy(new Error(`No connection to ${url.host} in ${connectTimeoutMs} ms`)),
      connectTimeoutMs,
    );
    upstream.once("socket", (socket) => {
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
        connected = true;
        clearTimeout(timer);
      });
    });
    upstream.on("error", (error) => (failure = error));
    upstream.once("response", (answer) => resolve(responseOf(answer, abort)));
    upstream.once("close", () => {
      clearTimeout(timer);
      // After an answer this settles nothing: the promise already resolved with it.
      resolve(
        connected ? broken(failure ?? new Error(`${url.host} closed the connection before it answered`)) : undefined,
      );
    });
    upstream.end(body);
  });
}

/** The headers a forward sends: the request's own, credentials included, but for those of its connection. */
function headersOf(headers: Headers, self: string, body: string | undefined): OutgoingHttpHeaders {
  // `Connection` may name more headers of the connection.
  const named = new Set(
    headers
      .get("connection")
      ?.split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  const sent: OutgoingHttpHeaders = {};
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name) && !SET_AGAIN.has(name) && !named.has(name)) sent[name] = value;
  }
  sent[FORWARDED_BY] = self;
  if (body !== undefined) sent["content-length"] = Buffer.byteLength(body);
  return sent;
}

/** The home's answer as this node's: its status, its headers but its connection's, and its body as the client reads it. */
function responseOf(answer: IncomingMessage, abort: () => void): Response {
  const headers = new Headers();
  for (let index = 0; index < answer.rawHeaders.length; index += 2) {
    const name = answer.rawHeaders[index]!.toLowerCase();
    if (!HOP_BY_HOP.has(name) && name !== "content-length") headers.append(name, answer.rawHeaders[index + 1]!);
  }
  const status = answer.statusCode ?? 502;
  if (NULL_BODY.has(status)) {
    answer.resume();
    return new Response(null, { status, headers });
  }
  // The iterator reads the answer's errors: a home cut off mid-stream breaks this body where it stopped.
  const chunks: AsyncIterator<Uint8Array> = answer[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    cancel: abort,
  });
  return new Response(stream, { status, statusText: answer.statusMessage ?? "", headers });
}

/** A 502 whose body breaks off at once: the home was sent the request, and its answer never came. */
function broken(error: unknown): Response {
  return new Response(new ReadableStream({ start: (controller) => controller.error(error) }), { status: 502 });
}
