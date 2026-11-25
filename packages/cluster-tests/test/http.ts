import { followedEventSchema } from "@chia1104/motoko-wire";
import type { AgentWireEvent } from "@chia1104/motoko-wire";

export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly body: Record<string, unknown> | undefined;
}

export async function call(
  base: string,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const response = await fetch(`${base}/call`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ method, params }),
  });
  const text = await response.text();
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  return { status: response.status, headers: response.headers, text, body };
}

interface Frame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
}

async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const frame: Record<string, string> = {};
      for (const line of buffer.slice(0, end).split("\n")) {
        const colon = line.indexOf(":");
        const field = line.slice(0, colon);
        frame[field === "" ? "comment" : field] = line.slice(colon + 1).replace(/^ /, "");
      }
      buffer = buffer.slice(end + 2);
      yield frame;
    }
  }
}

export async function follow(base: string, sessionId: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(`${base}/sessions/${sessionId}/events`, { headers, signal: controller.signal });
  return {
    response,
    frames: response.body === null ? undefined : framesOf(response.body),
    disconnect: () => controller.abort(),
  };
}

export interface Received {
  readonly id: string | undefined;
  readonly cursor: string;
  readonly event: AgentWireEvent;
}

export async function readUntil(
  frames: AsyncGenerator<Frame> | undefined,
  until: (event: AgentWireEvent) => boolean,
): Promise<Received[]> {
  if (frames === undefined) throw new Error("The follow has no body");
  const received: Received[] = [];
  for (;;) {
    const { done, value } = await frames.next();
    if (done === true) throw new Error(`The stream ended after ${received.map(({ event }) => event.type).join(", ")}`);
    if (value.comment !== undefined) continue;
    if (value.event !== undefined) throw new Error(`Unexpected ${value.event}: ${value.data}`);
    const { cursor, event } = followedEventSchema.parse(JSON.parse(value.data ?? ""));
    received.push({ id: value.id, cursor, event });
    if (until(event)) return received;
  }
}

export const isRunEnd = (event: AgentWireEvent): boolean => event.type === "run:end";

export async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
