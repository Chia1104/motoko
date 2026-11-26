import { callErrorSchema, followedEventSchema, followEndedSchema } from "@chia1104/motoko-wire";
import type { CallMethod, CallParams, Cursor } from "@chia1104/motoko-wire";

import { MotokoError } from "./client.ts";
import type { FollowListener, MotokoTransport } from "./client.ts";

export interface HttpTransportOptions {
  /** Where `motokoHandler`'s routes are, its `basePath` on the server: `/motoko`, or `https://api.example.com/motoko`. */
  readonly baseUrl: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Sent with every request, such as `Authorization`; a function is asked again for each, so a token can change. */
  readonly headers?: HttpHeaders | (() => HttpHeaders | Promise<HttpHeaders>);
}

/** What `fetch` takes as `headers`: a `Headers`, a record or a list of pairs. */
export type HttpHeaders = NonNullable<RequestInit["headers"]>;

const FIRST_RETRY_MS = 500;
const LAST_RETRY_MS = 30_000;

const reconnectDelay = (retries: number) =>
  Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * 2 ** retries) * (0.5 + Math.random() / 2);

/**
 * Motoko's call protocol over HTTP, as `@chia1104/motoko-node`'s `motokoHandler` serves it. Each call is a `POST
 * {baseUrl}/call`. Each follow is a `GET {baseUrl}/sessions/:id/events` whose server-sent events are read through
 * `fetch`, so a follow can send `headers` as a call does. A follow whose stream ends reconnects after a backoff, with
 * `Last-Event-ID` set to the client's cursor. So does a follow the server cannot serve now, answered with a 408, a 429
 * or a 5xx. A follow the server refuses before streaming, for a cursor or a session it cannot follow or a caller it does
 * not let, ends with that refusal and is not tried again.
 */
export function httpTransport(options: HttpTransportOptions): MotokoTransport {
  const base = options.baseUrl.replace(/\/+$/, "");
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const headersOf = async (own: Record<string, string>) => {
    const headers = new Headers(typeof options.headers === "function" ? await options.headers() : options.headers);
    for (const [name, value] of Object.entries(own)) headers.set(name, value);
    return headers;
  };

  async function call<M extends CallMethod>(method: M, params: CallParams<M>, signal: AbortSignal) {
    let response: Response;
    let text: string;
    try {
      const headers = await headersOf({ "content-type": "application/json" });
      response = await send(`${base}/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params }),
        signal,
      });
      text = await response.text();
    } catch {
      throw closed();
    }
    const body = jsonOf(text);
    if (response.ok && typeof body === "object" && body !== null && "result" in body) return body.result;
    throw refusalOf(response, body);
  }

  function follow(sessionId: string, from: () => Cursor | undefined, listener: FollowListener): () => void {
    const stop = new AbortController();
    const { signal } = stop;
    const url = `${base}/sessions/${encodeURIComponent(sessionId)}/events`;

    async function connect(): Promise<"ended" | "dropped" | "unreachable"> {
      const cursor = from();
      let response: Response;
      try {
        const headers = await headersOf({
          accept: "text/event-stream",
          ...(cursor !== undefined && { "last-event-id": cursor }),
        });
        response = await send(url, { headers, signal });
      } catch {
        return "unreachable";
      }
      if (signal.aborted) return "ended";
      if (response.status !== 200 || !isEventStream(response)) {
        const error = refusalOf(response, jsonOf(await response.text().catch(() => "")));
        if (isTransient(response)) return "unreachable";
        if (!signal.aborted) listener.ended(error);
        return "ended";
      }
      listener.live();
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      const parse = eventStreamParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return "dropped";
          for (const message of parse(value)) {
            if (signal.aborted) return "ended";
            if (message.event === "ended") {
              const ended = followEndedSchema.safeParse(jsonOf(message.data));
              if (!ended.success) continue;
              listener.ended(new MotokoError(ended.data.error.code, ended.data.error.message));
              return "ended";
            }
            if (message.event !== "message") continue;
            const followed = followedEventSchema.safeParse(jsonOf(message.data));
            if (!followed.success || followed.data.sessionId !== sessionId) continue;
            listener.event({ cursor: followed.data.cursor, event: followed.data.event });
          }
        }
      } catch {
        return "dropped";
      } finally {
        void reader.cancel().catch(() => undefined);
      }
    }

    void (async () => {
      for (let retries = 0; !signal.aborted; retries += 1) {
        const outcome = await connect();
        if (outcome === "ended" || signal.aborted) break;
        if (outcome === "dropped") {
          retries = 0;
          listener.dropped();
        }
        await pause(reconnectDelay(retries), signal);
      }
      stop.abort();
    })();
    return () => stop.abort();
  }

  return { call, follow };
}

const closed = () => new MotokoError("connection_closed", "The connection closed before the reply came");

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isTransient = (response: Response) =>
  response.status >= 500 || response.status === 408 || response.status === 429;

const isEventStream = (response: Response) =>
  response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";

function refusalOf(response: Response, body: unknown): MotokoError {
  const error = callErrorSchema.safeParse(
    typeof body === "object" && body !== null && "error" in body ? body.error : undefined,
  );
  if (error.success) return new MotokoError(error.data.code, error.data.message);
  const code = response.status === 401 || response.status === 403 ? "forbidden" : "internal";
  return new MotokoError(code, `The server answered ${response.status}`);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

interface EventStreamMessage {
  readonly event: string;
  readonly data: string;
}

const LINE_END = /\r\n|\r|\n/g;

/**
 * An event stream's messages as the server-sent events spec reads them, fed its text as it arrives. Lines end in CRLF,
 * LF or CR, and a CRLF split across two chunks is one line end. A line starting with `:` is a comment, `data` lines join
 * with `\n`, and a blank line dispatches a message with data.
 */
function eventStreamParser(): (text: string) => EventStreamMessage[] {
  let buffer = "";
  let afterCR = false;
  let event = "";
  let data: string[] = [];
  return (text) => {
    const messages: EventStreamMessage[] = [];
    if (afterCR && text !== "") {
      afterCR = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    buffer += text;
    let start = 0;
    for (const match of buffer.matchAll(LINE_END)) {
      const line = buffer.slice(start, match.index);
      start = match.index + match[0].length;
      if (line === "") {
        if (data.length > 0) messages.push({ event: event === "" ? "message" : event, data: data.join("\n") });
        event = "";
        data = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
    afterCR = start === buffer.length && buffer.endsWith("\r");
    buffer = buffer.slice(start);
    return messages;
  };
}
