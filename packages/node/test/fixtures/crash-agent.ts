import * as z from "zod";

import { defineAgent, defineTool } from "@chia1104/motoko-core";
import type { ToolContext } from "@chia1104/motoko-core";

export interface CrashPorts {
  readonly log: string[];
}

export const indexStarted: { notify: () => void } = { notify: () => undefined };

export const indexEnd: { finish: boolean; release?: Promise<void> } = { finish: false };

const indexFiles = defineTool({
  name: "index_files",
  description: "Index a directory",
  tier: "read",
  replay: "safe",
  parameters: z.object({ path: z.string() }),
  async execute({ path }, { ports, signal }: ToolContext<CrashPorts>) {
    indexStarted.notify();
    if (indexEnd.release) await indexEnd.release;
    else if (!indexEnd.finish)
      await new Promise((_, reject) => signal.addEventListener("abort", reject, { once: true }));
    ports.log.push(`indexed ${path}`);
    return { text: `indexed ${path}` };
  },
});

const publish = defineTool({
  name: "publish",
  description: "Publish a post",
  tier: "publish",
  parameters: z.object({ slug: z.string() }),
  async execute({ slug }, { ports }: ToolContext<CrashPorts>) {
    ports.log.push(`published ${slug}`);
    return { text: `published ${slug}` };
  },
});

export const crashAgent = defineAgent<CrashPorts>({
  kind: "crash",
  instructions: "You index and publish.",
  tools: [indexFiles, publish],
  policy: { requiresApproval: ["publish"] },
});
