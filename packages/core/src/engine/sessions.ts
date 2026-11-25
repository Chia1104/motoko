import { defineDoc } from "@earendil-works/pi-durable";

import type { AgentDefinition } from "../agent.ts";

import type { EpochMs } from "./calls.ts";

/** Which of the agent's tools a session may use: exactly these, by name, or every one but those in `remove`. */
export type ToolSelection = readonly string[] | { readonly remove: readonly string[] };

/**
 * Which calls of a session wait for an operator's decision: exactly the calls of tools whose tier is listed, or what
 * the agent's policy gates, with the tiers in `add` gated as well and those in `remove` not.
 */
export type ApprovalRule =
  | readonly string[]
  | { readonly add?: readonly string[]; readonly remove?: readonly string[] };

// These are type aliases, not interfaces, because the document must be a pi `JsonObject`, and only an alias has the
// implicit index signature that `JsonObject` takes.
// oxlint-disable-next-line typescript/consistent-type-definitions
type StoredRule = string[] | { add?: string[]; remove?: string[] };
// oxlint-disable-next-line typescript/consistent-type-definitions
export type SessionRecord = {
  createdAt: EpochMs;
  requiresApproval?: StoredRule;
  requestId?: string;
  agent?: string;
  parent?: { sessionId: string; toolCallId: string };
};

export const SessionsDoc = defineDoc<{ sessions: Record<string, SessionRecord>; erasing: number[] }>({
  kind: "runtime.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {}, erasing: [] }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export function withChildren(sessions: Readonly<Record<string, SessionRecord>>, sessionId: string): string[] {
  const children = new Map<string, string[]>();
  for (const [id, record] of Object.entries(sessions)) {
    const parent = record.parent?.sessionId;
    if (parent === undefined) continue;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [id]);
    else siblings.push(id);
  }
  const breadthFirst = [sessionId];
  for (const parent of breadthFirst) {
    for (const child of children.get(parent) ?? []) breadthFirst.push(child);
  }
  return breadthFirst;
}

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

function stringsOf(value: unknown, what: string): string[] {
  if (!isList(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${what} must be a list of strings`);
  }
  return [...value];
}

export function storedRule(kind: string, tiers: ReadonlySet<string>, rule: ApprovalRule): StoredRule {
  const known = (list: readonly string[], what: string) => {
    for (const tier of list) {
      if (!tiers.has(tier)) throw new TypeError(`${what} names tier \`${tier}\`, which no tool of \`${kind}\` has`);
    }
    return [...list];
  };
  if (isList(rule)) return known(stringsOf(rule, "`requiresApproval`"), "`requiresApproval`");
  if (typeof rule !== "object" || rule === null) {
    throw new TypeError("`requiresApproval` must be a list of tiers or `{ add?, remove? }`");
  }
  const { add, remove } = rule;
  return {
    ...(add !== undefined && { add: known(stringsOf(add, "`requiresApproval.add`"), "`requiresApproval.add`") }),
    ...(remove !== undefined && {
      remove: known(stringsOf(remove, "`requiresApproval.remove`"), "`requiresApproval.remove`"),
    }),
  };
}

export function selectedTools(agent: AgentDefinition, selection: ToolSelection): string[] {
  const names = isList(selection)
    ? stringsOf(selection, "`tools`")
    : typeof selection === "object" && selection !== null && "remove" in selection
      ? stringsOf(selection.remove, "`tools.remove`")
      : undefined;
  if (names === undefined) throw new TypeError("`tools` must be a list of tool names or `{ remove }`");
  for (const name of names) {
    if (agent.tool(name) === undefined) throw new TypeError(`Agent \`${agent.kind}\` has no tool \`${name}\``);
  }
  const named = new Set(names);
  return agent.tools.map((tool) => tool.name).filter((name) => named.has(name) === isList(selection));
}
