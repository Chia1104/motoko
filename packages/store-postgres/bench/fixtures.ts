// The agent, its tools and the scripted models the benchmark runs: pi-ai's faux provider, offline. Two providers:
// `bench-paced` streams at a set rate (the turns users wait for), `bench-fast` streams at once (building history).

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as z from "zod";

import { defineAgent, defineTool } from "@chia1104/motoko-core";
import type { AgentSession } from "@chia1104/motoko-core";
import type { AgentWireEvent, StreamItem } from "@chia1104/motoko-wire";

export const lookup = defineTool({
  name: "lookup",
  description: "Look a value up",
  tier: "read",
  replay: "safe",
  parameters: z.object({ key: z.string() }),
  async execute({ key }) {
    return { text: `value of ${key}`, details: { key } };
  },
});

export const notify = defineTool({
  name: "notify",
  description: "Send a notice",
  tier: "write",
  parameters: z.object({ text: z.string() }),
  async execute({ text }) {
    return { text: `sent ${text}` };
  },
});

export const agent = defineAgent({
  kind: "bench",
  instructions: "You answer questions and send notices.",
  tools: [lookup, notify],
  policy: { requiresApproval: ["write"] },
});

/** When each streamed text chunk left the model: per response, the text so far and its time. */
export interface Emission {
  readonly requestedAt: number;
  text: string;
  readonly marks: [chars: number, at: number][];
}

/** A faux provider whose streams are tapped: the benchmark knows when every chunk was produced. */
function tappedProvider(id: string, options: { tokensPerSecond?: number }) {
  const core = createFauxCore({
    provider: id,
    ...(options.tokensPerSecond !== undefined && {
      tokensPerSecond: options.tokensPerSecond,
      tokenSize: { min: 1, max: 1 },
    }),
  });
  const emissions: Emission[] = [];
  const tap =
    (stream: typeof core.stream): typeof core.stream =>
    (model, context, streamOptions) => {
      const emission: Emission = { requestedAt: performance.now(), text: "", marks: [] };
      emissions.push(emission);
      const events = stream(model, context, streamOptions);
      const push = events.push.bind(events);
      events.push = (event) => {
        if (event.type === "text_delta") {
          emission.text += event.delta;
          emission.marks.push([emission.text.length, performance.now()]);
        }
        push(event);
      };
      return events;
    };
  const provider = createProvider({
    id,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: {
      stream: tap(core.stream),
      streamSimple: tap(core.streamSimple),
      fetchDeferred: core.fetchDeferred,
      cancelDeferred: core.cancelDeferred,
    },
  });
  return {
    provider,
    model: { provider: id, modelId: core.getModel().id },
    emissions,
    setResponses: (responses: AssistantMessage[]) => core.setResponses(responses),
    pending: () => core.getPendingResponseCount(),
  };
}

export function benchModels(tokensPerSecond: number) {
  const paced = tappedProvider("bench-paced", { tokensPerSecond });
  const fast = tappedProvider("bench-fast", {});
  const models = createModels();
  models.setProvider(paced.provider);
  models.setProvider(fast.provider);
  return { models, paced, fast };
}

let tagCounter = 0;

/** About `tokens` tokens of text (4 characters each, as the faux provider counts), starting with a unique tag. */
export function answer(tokens: number): AssistantMessage {
  const tag = `[r${++tagCounter}] `;
  const words = ["lorem ", "ipsum ", "dolor ", "sitam ", "conse ", "ctetu ", "adipi ", "scing "];
  let text = tag;
  for (let i = 0; text.length < tokens * 4; i++) text += words[i % words.length];
  return fauxAssistantMessage(text.slice(0, tokens * 4));
}

export const threeLookups = (): AssistantMessage =>
  fauxAssistantMessage(
    [
      fauxToolCall("lookup", { key: "alpha" }),
      fauxToolCall("lookup", { key: "beta" }),
      fauxToolCall("lookup", { key: "gamma" }),
    ],
    { stopReason: "toolUse" },
  );

export const gatedCall = (): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("notify", { text: "deploy done" })], { stopReason: "toolUse" });

export interface Arrival {
  readonly at: number;
  readonly item: StreamItem;
}

/** A client reading a session's stream in the background, as a browser tab holding an SSE connection does. */
export class Reader {
  readonly arrivals: Arrival[] = [];
  readonly #controller = new AbortController();
  readonly #waiters = new Set<() => void>();
  readonly done: Promise<void>;
  error: unknown;

  constructor(session: AgentSession, from?: string) {
    this.done = (async () => {
      try {
        for await (const item of session.events({
          ...(from !== undefined && { from }),
          signal: this.#controller.signal,
        })) {
          this.arrivals.push({ at: performance.now(), item });
          for (const waiter of [...this.#waiters]) waiter();
        }
      } catch (error) {
        this.error = error;
      } finally {
        for (const waiter of [...this.#waiters]) waiter();
      }
    })();
  }

  /** The first arrival at or after index `from` whose event matches. */
  async waitFor(
    from: number,
    match: (event: AgentWireEvent) => boolean,
    timeoutMs = 120_000,
  ): Promise<Arrival & { index: number }> {
    const deadline = performance.now() + timeoutMs;
    let index = from;
    for (;;) {
      for (; index < this.arrivals.length; index++) {
        const arrival = this.arrivals[index] as Arrival;
        if (match(arrival.item.event)) return { ...arrival, index };
      }
      if (this.error !== undefined) throw this.error;
      if (performance.now() > deadline) {
        throw new Error(
          `Timed out; read ${this.arrivals
            .slice(from)
            .map((a) => a.item.event.type)
            .join(", ")}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(1, deadline - performance.now()));
        function done() {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        }
        const waiters = this.#waiters;
        waiters.add(done);
      });
    }
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await this.done;
  }
}

/**
 * Streaming as the reader saw it, from arrival `from` on: when each delta arrived, the gaps between deltas of one
 * message, and each delta's lag behind the model producing its last character.
 */
export function deltaTimings(arrivals: readonly Arrival[], from: number, emissions: readonly Emission[]) {
  const times: number[] = [];
  const gaps: number[] = [];
  const lags: number[] = [];
  let text = "";
  let previous: number | undefined;
  for (const { at, item } of arrivals.slice(from)) {
    const event = item.event;
    if (event.type === "assistant:start") {
      text = "";
      previous = undefined;
      continue;
    }
    if (event.type !== "assistant:delta" || event.channel !== "text") continue;
    text += event.delta;
    times.push(at);
    if (previous !== undefined) gaps.push(at - previous);
    previous = at;
    const emission = [...emissions].reverse().find((candidate) => candidate.text.startsWith(text));
    const mark = emission?.marks.find(([chars]) => chars >= text.length);
    if (mark) lags.push(at - mark[1]);
  }
  return { times, gaps, lags };
}
