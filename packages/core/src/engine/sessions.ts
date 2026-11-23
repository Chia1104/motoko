import { defineDoc } from "@earendil-works/pi-durable";

import type { AgentDefinition } from "../agent.ts";

/** Which of the agent's tools a session may use: exactly these, by name, or every one but those in `remove`. */
export type ToolSelection = readonly string[] | { readonly remove: readonly string[] };

/**
 * Which calls of a session wait for an operator's decision: exactly the calls of tools whose tier is listed, or what
 * the agent's policy gates, with the tiers in `add` gated as well and those in `remove` not.
 */
export type ApprovalRule =
  | readonly string[]
  | { readonly add?: readonly string[]; readonly remove?: readonly string[] };

// Type aliases, not interfaces: the document must be a pi `JsonObject`, and only an alias has the implicit index
// signature that takes.
// oxlint-disable-next-line typescript/consistent-type-definitions
type StoredRule = string[] | { add?: string[]; remove?: string[] };
// oxlint-disable-next-line typescript/consistent-type-definitions
export type SessionRecord = {
  /** Epoch ms. */
  createdAt: number;
  /** The session's own approval rule; absent, the agent's policy decides. */
  requiresApproval?: StoredRule;
  /** The `createSession` request that made it: a retry of that request finds this session. */
  requestId?: string;
  /** The kind of the sub-agent a child session runs; absent, the instance's agent. */
  agent?: string;
  /** A child session's delegate call: the session it was made in and the call that owns it. */
  parent?: { sessionId: string; toolCallId: string };
};

/**
 * The runtime's record of an instance's sessions: one document for all of them, so listing them is one read. A
 * conversation is a session while it is listed here; `erasing` holds deleted sessions whose data the host has not
 * erased yet, which the runtime hands to the host's `erase` once the instance's storage is closed. A session's request
 * ID is remembered as long as it is listed. A record with `parent` is a child session, which its delegate's call made
 * in the same commit as its conversation.
 */
export const SessionsDoc = defineDoc<{ sessions: Record<string, SessionRecord>; erasing: number[] }>({
  kind: "runtime.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {}, erasing: [] }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** Session `sessionId` and the child sessions under it, theirs included, parents first. */
export function withChildren(sessions: Readonly<Record<string, SessionRecord>>, sessionId: string): string[] {
  const children = new Map<string, string[]>();
  for (const [id, record] of Object.entries(sessions)) {
    const parent = record.parent?.sessionId;
    if (parent === undefined) continue;
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [id]);
    else siblings.push(id);
  }
  const found = [sessionId];
  // The iteration reaches the children it appends, and theirs.
  for (const parent of found) {
    for (const child of children.get(parent) ?? []) found.push(child);
  }
  return found;
}

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

function stringsOf(value: unknown, what: string): string[] {
  if (!isList(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${what} must be a list of strings`);
  }
  return [...value];
}

/** The tiers the agent's tools carry. */
const tiersOf = (agent: AgentDefinition) => new Set(agent.tools.map((tool) => tool.tier));

/** `rule` as stored, after checking that it names only tiers the agent's tools carry. */
export function storedRule(agent: AgentDefinition, rule: ApprovalRule): StoredRule {
  const tiers = tiersOf(agent);
  const known = (list: readonly string[], what: string) => {
    for (const tier of list) {
      if (!tiers.has(tier))
        throw new TypeError(`${what} names tier \`${tier}\`, which no tool of \`${agent.kind}\` has`);
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

/** The agent's tool names `selection` enables, in the agent's order, after checking that it names only its tools. */
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
