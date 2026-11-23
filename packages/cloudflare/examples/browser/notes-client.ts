// Without React: the Agents SDK's AgentClient, and Motoko's client over it.
import { AgentClient } from "agents/client";

import { motokoClient, webSocketTransport } from "@chia1104/motoko-client";
import type { MotokoSessionState } from "@chia1104/motoko-client";

declare function render(state: MotokoSessionState): void;

const agent = new AgentClient({ agent: "notes", name: "ada", host: location.host });
// One client per socket: every caller of motokoClient(webSocketTransport(agent)) shares it.
const motoko = motokoClient(webSocketTransport(agent));

const { id } = await motoko.createSession();
const unfollow = motoko.follow(id, render);
await motoko.submit(id, { text: "Note that the milk is out.", requestId: crypto.randomUUID() });
// …and once the page is done with the session:
unfollow();
