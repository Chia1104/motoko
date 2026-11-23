import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TLSSocket } from "node:tls";

/** A Fetch API handler, such as `motokoHandler`'s. */
export type FetchHandler = (request: Request) => Promise<Response>;

export interface NodeListenerOptions {
  /**
   * The handler rejected, or its response's body failed. The request is answered 500, or its connection is cut once
   * its response has begun.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * `handler` as a request listener of Node's `http.createServer` (or `https`'s): each request becomes a `Request` whose
 * `signal` aborts when the client goes away, and its `Response` is written back only as fast as the client reads it.
 */
export function nodeListener(
  handler: FetchHandler,
  options?: NodeListenerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    serve(handler, req, res).catch((error: unknown) => {
      options?.onError?.(error);
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    });
  };
}

async function serve(handler: FetchHandler, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const scheme = req.socket instanceof TLSSocket ? "https" : "http";
  const url = URL.parse(req.url ?? "/", `${scheme}://${req.headers.host ?? "localhost"}`);
  if (url === null) {
    res.writeHead(400).end();
    return;
  }
  const gone = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) gone.abort();
  });
  const response = await handler(new Request(url, requestInit(req, gone.signal)));
  for (const [name, value] of response.headers) res.appendHeader(name, value);
  res.writeHead(response.status);
  if (response.body === null) {
    res.end();
    return;
  }
  // The headers go out now: an event stream may send its first event much later.
  res.flushHeaders();
  try {
    // `pipeline` reads the body as `res` drains, and cancels it if `res` closes first.
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!gone.signal.aborted) throw error;
  }
}

function requestInit(req: IncomingMessage, signal: AbortSignal): RequestInit {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    headers.append(req.rawHeaders[index]!, req.rawHeaders[index + 1]!);
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return { method, headers, signal };
  // Not `Readable.toWeb`: on Node 22.19 it enqueues a chunk that arrives after the body was cancelled (a call refused
  // 413 while the client still sends), which throws out of the socket's read, uncaught, and cuts the answer off.
  return { method, headers, signal, body: ReadableStream.from(req), duplex: "half" };
}
