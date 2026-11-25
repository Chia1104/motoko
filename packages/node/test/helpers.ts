import type { AgentSession } from "@chia1104/motoko-core";
import { foldEvents } from "@chia1104/motoko-wire";
import type { AgentSessionView, StreamItem } from "@chia1104/motoko-wire";

export function follow(session: AgentSession, from?: string) {
  const controller = new AbortController();
  const items: StreamItem[] = [];
  const done = (async () => {
    for await (const item of session.events({ ...(from !== undefined && { from }), signal: controller.signal })) {
      items.push(item);
    }
  })();
  return {
    items,
    async stop(): Promise<void> {
      controller.abort();
      await done;
    },
  };
}

export async function eventually(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

export const fold = (...lists: (readonly StreamItem[])[]): AgentSessionView =>
  foldEvents(lists.flat().map((item) => item.event));

export const has = (items: readonly StreamItem[], type: string) => items.some((item) => item.event.type === type);

export const runEnds = (items: readonly StreamItem[]) => items.filter((item) => item.event.type === "run:end").length;
