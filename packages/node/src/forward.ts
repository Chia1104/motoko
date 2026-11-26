import { request as httpRequest } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

import type { LeaseHeldError } from "@chia1104/motoko-core/store";

/**
 * Experimental. The options of one node in a cluster whose nodes share one database store. The home of each instance,
 * the node that holds its lease, serves it. The `holder` of the store's lease row names that node by its internal URL.
 */
export interface ClusterOptions {
  /**
   * This node's internal base URL, where its peers reach its routes, such as `http://10.0.0.7:3000/motoko`. The
   * store's leases name it as their holder, so the store's `holder` option is the same string.
   */
  readonly self: string;
  /**
   * The holders this node may forward to, as a list of their base URLs or a predicate on one holder. A forward carries
   * the caller's credentials, so a holder read from the database gets a request only when the app names it one of its
   * own nodes.
   */
  readonly peers: readonly string[] | ((holder: string) => boolean);
  /** How long a forward waits to connect to the home before it answers 503 `lease_held`. Default: 2 000 ms. */
  readonly connectTimeoutMs?: number;
}

/** The header a forward sets to the node that sent it. A request that carries it is never forwarded again. */
export const FORWARDED_BY = "motoko-forwarded-by";

export type Forward = (
  error: LeaseHeldError,
  request: Request,
  path: string,
  body: string | undefined,
) => Promise<Response | undefined>;

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

const SET_BY_OUTGOING_REQUEST = new Set(["host", "content-length", "expect"]);

const NULL_BODY = new Set([204, 205, 304]);

const isHttp = (url: URL | null): url is URL => url?.protocol === "http:" || url?.protocol === "https:";

type Sent = { readonly reached: true; readonly response: Response } | { readonly reached: false };

export function forwarder(options: ClusterOptions): Forward {
  const { self, peers } = options;
  if (!isHttp(URL.parse(self))) throw new TypeError("`cluster.self` is an http(s) URL");
  const isPeer = typeof peers === "function" ? peers : (holder: string) => peers.includes(holder);
  const isStaleLeaseOfThisNode = (holder: string) => holder === self;
  const connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
  if (!(Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0)) {
    throw new TypeError("`cluster.connectTimeoutMs` must be a positive number of milliseconds");
  }

  return async (error, request, path, body) => {
    if (request.headers.has(FORWARDED_BY)) return undefined;
    const { holder } = error;
    if (holder === undefined || isStaleLeaseOfThisNode(holder)) return undefined;
    if (isPeer(holder) !== true) return undefined;
    const home = URL.parse(`${holder.replace(/\/+$/, "")}${path}`);
    if (!isHttp(home)) return undefined;
    const sent = await send(home, request, body, self, connectTimeoutMs);
    return sent.reached ? sent.response : undefined;
  };
}

function send(
  url: URL,
  request: Request,
  body: string | undefined,
  self: string,
  connectTimeoutMs: number,
): Promise<Sent> {
  return new Promise((resolve) => {
    const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: request.method,
      headers: headersOf(request.headers, self, body),
      // A fresh connection, never a pooled socket. A pooled socket that the home dropped meanwhile fails after the
      // request is written, so a home that is gone would look like a home that cut the call off. A fresh connection
      // fails before anything is sent.
      agent: false,
    });
    let connected = false;
    let failure: unknown;
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
    upstream.once("response", (answer) => resolve({ reached: true, response: responseOf(answer, abort) }));
    upstream.once("close", () => {
      clearTimeout(timer);
      if (!connected) {
        resolve({ reached: false });
        return;
      }
      const error = failure ?? new Error(`${url.host} closed the connection before it answered`);
      resolve({ reached: true, response: badGatewayWithErroredBody(error) });
    });
    upstream.end(body);
  });
}

function headersOf(headers: Headers, self: string, body: string | undefined): OutgoingHttpHeaders {
  // The `Connection` header may name further hop-by-hop headers.
  const named = new Set(
    headers
      .get("connection")
      ?.split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  const sent: OutgoingHttpHeaders = {};
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name) && !SET_BY_OUTGOING_REQUEST.has(name) && !named.has(name)) sent[name] = value;
  }
  sent[FORWARDED_BY] = self;
  if (body !== undefined) sent["content-length"] = Buffer.byteLength(body);
  return sent;
}

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

function badGatewayWithErroredBody(error: unknown): Response {
  return new Response(new ReadableStream({ start: (controller) => controller.error(error) }), { status: 502 });
}
