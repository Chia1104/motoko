// A process that starts a run and is then killed with SIGKILL by `crash.test.ts`. A client in it
// follows the session's stream; once the run reached the point the scenario names, the process
// prints that client's items (`ITEMS <json>`) and `READY <sessionId>`, then waits forever.

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createAgentRuntime } from "@chia1104/motoko-core";
import type { StreamItem } from "@chia1104/motoko-wire";

import { nodeHost, sqliteStorage } from "../../src/index.ts";

import { crashAgent, crashState } from "./crash-agent.ts";

const [directory, scenario] = process.argv.slice(2);
if (directory === undefined || (scenario !== "tool" && scenario !== "approval")) {
  throw new Error("usage: crash-child.ts <directory> tool|approval");
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  scenario === "tool"
    ? fauxAssistantMessage(fauxToolCall("index_files", { path: "/srv" }, { id: "idx-1" }), { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxToolCall("publish", { slug: "launch" }, { id: "pub-1" }), { stopReason: "toolUse" }),
]);

const runtime = createAgentRuntime({
  agents: [crashAgent],
  host: nodeHost({ storage: sqliteStorage({ directory }) }),
  models,
  ports: { log: [] },
  defaultModel: { provider: faux.provider.id, modelId: faux.getModel().id },
});
const instance = runtime.get(crashAgent, "c1");
const { id } = await instance.createSession();
const session = instance.session(id);

let started = false;
const items: StreamItem[] = [];
const cut = scenario === "tool" ? "tool:start" : "approval:request";
let ready = false;
const check = (): void => {
  if (ready || !items.some((item) => item.event.type === cut) || (scenario === "tool" && !started)) return;
  ready = true;
  process.stdout.write(`ITEMS ${JSON.stringify(items)}\nREADY ${id}\n`);
};
crashState.started = () => {
  started = true;
  check();
};
const reading = (async () => {
  for await (const item of session.events()) {
    items.push(item);
    check();
  }
})();
await session.submit({ text: scenario === "tool" ? "Index /srv" : "Publish launch", requestId: "crash-1" });
await reading;
await new Promise(() => undefined);
