import type { ModelRef } from "@earendil-works/pi-durable";

import { scopePartProblem } from "./host.ts";
import type { ToolDefinition } from "./tool.ts";

export interface AgentPolicy {
  /** Whether a call of a tool of `tier` waits for an operator's decision before it runs. */
  requiresApproval(tier: string, toolName: string): boolean;
}

export interface AgentDefinitionInput<Ports> {
  /** The agent kind. With an instance's name it forms the instance's `StorageScope`. */
  readonly kind: string;
  /** The system prompt, rendered before every request. */
  readonly instructions: string;
  readonly tools: readonly ToolDefinition<Ports>[];
  /** The tiers that need approval, or a function that decides it. By default no tier needs approval. */
  readonly policy?: { readonly requiresApproval: readonly string[] | AgentPolicy["requiresApproval"] };
  /** The model a new session uses unless it names one. It is pi-durable's `ModelRef`, never a credential. */
  readonly model?: ModelRef;
}

/**
 * What an agent is, without ports or credentials, so a client or a capability listing can import it. `Ports` is the
 * ports its tools need. It appears only in parameter positions, so an agent that needs fewer ports fits a runtime that
 * has more.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- any agent fits, whatever its ports
export interface AgentDefinition<Ports = any> {
  readonly kind: string;
  readonly instructions: string;
  readonly tools: readonly ToolDefinition<Ports>[];
  readonly policy: AgentPolicy;
  readonly model?: ModelRef;
  /** The tool of a name, if the agent has one. */
  tool(name: string): ToolDefinition<Ports> | undefined;
}

export function defineAgent<Ports = unknown>(input: AgentDefinitionInput<Ports>): AgentDefinition<Ports> {
  const problem = scopePartProblem(input.kind);
  if (problem !== undefined) throw new TypeError(`An agent's kind ${problem}`);
  const byName = new Map<string, ToolDefinition<Ports>>();
  for (const tool of input.tools) {
    if (byName.has(tool.name)) throw new TypeError(`Agent \`${input.kind}\` declares tool \`${tool.name}\` twice`);
    byName.set(tool.name, tool);
  }
  const rule = input.policy?.requiresApproval ?? [];
  const requiresApproval: AgentPolicy["requiresApproval"] =
    typeof rule === "function" ? rule : (tier) => rule.includes(tier);
  return Object.freeze({
    kind: input.kind,
    instructions: input.instructions,
    tools: Object.freeze([...input.tools]),
    policy: Object.freeze({ requiresApproval }),
    ...(input.model !== undefined && { model: input.model }),
    tool: (name: string) => byName.get(name),
  });
}

export function agentsOf(roots: readonly AgentDefinition[]): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>();
  const visit = (agent: AgentDefinition) => {
    const known = agents.get(agent.kind);
    if (known === agent) return;
    if (known !== undefined) throw new TypeError(`Two agent definitions of kind \`${agent.kind}\``);
    agents.set(agent.kind, agent);
    for (const tool of agent.tools) if (tool.kind === "delegate") visit(tool.agent);
  };
  for (const root of roots) visit(root);
  return agents;
}
