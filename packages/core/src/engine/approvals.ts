import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { JsonValue as ModelJsonValue } from "@earendil-works/pi-ai";
import { defineDoc, defineSignal, hook, LiveDoc, ToolTask } from "@earendil-works/pi-durable";
import type { ConversationId, Harness, HookRegistration, JsonObject, TaskId } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";

import type { AgentDefinition } from "../agent.ts";
import { ApprovalNotPendingError } from "../errors.ts";

import { callsOf, startedCall } from "./calls.ts";
import type { EpochMs } from "./calls.ts";
import { MODEL_ARGS } from "./extensions.ts";
import type { GatedTool } from "./extensions.ts";
import { SessionsDoc } from "./sessions.ts";
import type { ApprovalRule } from "./sessions.ts";

const context = BACKGROUND_CONTEXT;

export interface ApprovalDecision {
  readonly toolCallId: string;
  readonly approved: boolean;
  /** When the operator declines the call, the model reads this as the call's result. */
  readonly comment?: string;
}

export interface ApprovalOutcome {
  readonly toolCallId: string;
  readonly outcome: "applied" | "already_decided";
}

const ApprovalSignal = defineSignal({
  name: "runtime.approval",
  version: 1,
  schema: obj({ approved: bool(), comment: opt(str()) }),
});

// This is a type alias, not an interface, because the decisions document must be a pi `JsonObject`, and only an alias
// has the implicit index signature that `JsonObject` takes.
// oxlint-disable-next-line typescript/consistent-type-definitions
type StoredDecision = {
  approved: boolean;
  comment?: string;
  args?: JsonObject;
  at: EpochMs;
};

export type Decisions = Readonly<Record<string, StoredDecision>>;

export const ApprovalsDoc = defineDoc<{ decisions: Record<string, StoredDecision> }>({
  kind: "runtime.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ decisions: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export function isGated(agent: AgentDefinition, tool: GatedTool, rule?: ApprovalRule): boolean {
  const { tier, name } = tool;
  if (tier === undefined) return true;
  if (rule === undefined) return agent.policy.requiresApproval(tier, name);
  if (Array.isArray(rule)) return rule.includes(tier);
  const { add, remove } = rule as Exclude<ApprovalRule, readonly string[]>;
  if (remove?.includes(tier)) return false;
  return add?.includes(tier) === true || agent.policy.requiresApproval(tier, name);
}

export function ruleOf(
  sessions: Readonly<{ sessions: Readonly<Record<string, { readonly requiresApproval?: ApprovalRule }>> }> | undefined,
  conversationId: ConversationId,
): ApprovalRule | undefined {
  return sessions?.sessions[String(conversationId)]?.requiresApproval;
}

/**
 * pi-durable runs the whole `call` phase again at every wake, registry change and decision, and an app hook may rewrite
 * the call anew on each pass.
 */
const GATE_ARGS = "motoko.gate.args";

const GATE_UNTIL = "motoko.gate.until";

export const NO_DECISION_IN_TIME = "No decision arrived in time.";

export const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: ModelJsonValue): value is readonly ModelJsonValue[] => Array.isArray(value);

/** Whether two JSON values are equal whatever the order of their objects' keys. A JSON column may reorder the keys. */
function sameJson(a: ModelJsonValue | undefined, b: ModelJsonValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (isList(a) || isList(b)) {
    return isList(a) && isList(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
  );
}

export async function gateArgsOf(harness: Harness, taskId: TaskId): Promise<JsonObject | undefined> {
  const args = (await harness.getTask(taskId, context))?.memos?.[GATE_ARGS];
  return isObject(args) ? args : undefined;
}

function declineText(comment: string | undefined): string {
  return comment === undefined || comment.trim().length === 0
    ? "The operator declined this call."
    : `The operator declined this call: ${comment}`;
}

export function approvalGate(
  agent: AgentDefinition,
  toolOf: (name: string) => GatedTool,
  nestedTimeoutMs: number,
): HookRegistration {
  return hook(ToolTask, {
    async beforeTool(call, api, context) {
      const state = await api.readSignal(ApprovalSignal, call.id, context);
      if (state !== undefined) {
        if ("expired" in state) {
          return { block: call.parent === undefined ? "No decision arrived for this call." : NO_DECISION_IN_TIME };
        }
        if (!state.value.approved) return { block: declineText(state.value.comment) };
        const asked = await api.memo<JsonObject>(GATE_ARGS, context);
        if (asked !== undefined) return { arguments: asked };
        const model = await api.memo<JsonObject>(MODEL_ARGS, context);
        return model === undefined || sameJson(model, call.arguments)
          ? undefined
          : { block: "The call's arguments changed after the operator was asked about it." };
      }
      const rule = ruleOf(await api.snapshot(SessionsDoc, context), api.conversationId);
      if (!isGated(agent, toolOf(call.name), rule)) return undefined;
      // SAFETY: pi-ai's JSON arguments differ from pi-durable's JSON only in typing their arrays readonly.
      await api.memo(GATE_ARGS, call.arguments as JsonObject, context);
      const signals = [ApprovalSignal.key(call.id)];
      if (call.parent === undefined) return { sleep: { signals } };
      const until = await api.memo(GATE_UNTIL, api.now() + nestedTimeoutMs, context);
      return api.now() < until ? { sleep: { signals, until } } : { block: NO_DECISION_IN_TIME };
    },
    async afterTool(call, result, api, context) {
      if (!result.diagnostics?.some((diagnostic) => diagnostic.code === "blocked")) return undefined;
      const state = await api.readSignal(ApprovalSignal, call.id, context);
      if (state === undefined || "expired" in state) {
        const until = call.parent === undefined ? undefined : await api.memo<number>(GATE_UNTIL, context);
        if (until === undefined || api.now() < until) return undefined;
        return {
          output: [{ type: "text", text: NO_DECISION_IN_TIME }],
          isError: true,
          diagnostics: [{ severity: "error", code: "no_decision", message: NO_DECISION_IN_TIME }],
        };
      }
      if (state.value.approved) return undefined;
      const text = declineText(state.value.comment);
      // The model reads the operator's words, not the harness's report of a blocked call. The tool that made a nested
      // call reads no output of an error, only its error diagnostics, so for a nested call the words are a diagnostic.
      return {
        output: [{ type: "text", text }],
        isError: true,
        diagnostics: call.parent === undefined ? [] : [{ severity: "error", code: "declined", message: text }],
      };
    },
  });
}

class Refused extends Error {
  readonly toolCallId: string;
  constructor(toolCallId: string) {
    super(toolCallId);
    this.toolCallId = toolCallId;
  }
}

export async function decide(
  harness: Harness,
  conversationId: ConversationId,
  gated: (toolName: string) => boolean,
  decisions: readonly ApprovalDecision[],
): Promise<ApprovalOutcome[]> {
  const ids = new Set<string>();
  for (const { toolCallId } of decisions) {
    if (ids.has(toolCallId)) throw new TypeError(`Tool call ${toolCallId} is decided twice`);
    ids.add(toolCallId);
  }
  if (decisions.length === 0) return [];
  const [live, calls] = await Promise.all([
    harness.snapshot(LiveDoc, conversationId, context),
    callsOf(harness, conversationId),
  ]);
  const tasks = decisions.map((decision) => {
    const named = (candidate: { callId: string }) => candidate.callId === decision.toolCallId;
    const slot = live?.tools?.find(named) ?? live?.nestedTools?.find(named);
    const waiting =
      slot !== undefined &&
      ((slot.status === "sleeping" && startedCall(calls, slot.callId, slot.taskId) === undefined) ||
        (slot.status === "pending" && gated(slot.name)));
    if (!waiting || slot.taskId === undefined) throw new ApprovalNotPendingError(decision.toolCallId);
    return slot.taskId;
  });
  try {
    return await harness.commit(async (tx) => {
      const outcomes: ApprovalOutcome[] = [];
      const doc = await tx.doc(ApprovalsDoc, conversationId);
      // Read before any write, because a transaction reads no table after its first write.
      const asked = await Promise.all(tasks.map(async (task) => (await tx.task(task))?.memos?.[GATE_ARGS]));
      for (const [index, decision] of decisions.entries()) {
        const comment = decision.comment;
        const delivered = await tx.signal(tasks[index]!, ApprovalSignal, decision.toolCallId, {
          approved: decision.approved,
          ...(comment !== undefined && { comment }),
        });
        if (delivered === "duplicate") {
          outcomes.push({ toolCallId: decision.toolCallId, outcome: "already_decided" });
          continue;
        }
        if (delivered !== "delivered") throw new Refused(decision.toolCallId);
        const args = asked[index];
        const stored: StoredDecision = {
          approved: decision.approved,
          ...(comment !== undefined && { comment }),
          ...(isObject(args) && { args }),
          at: Date.now(),
        };
        doc.decisions[decision.toolCallId] = stored;
        outcomes.push({ toolCallId: decision.toolCallId, outcome: "applied" });
      }
      return outcomes;
    }, context);
  } catch (error) {
    if (error instanceof Refused) throw new ApprovalNotPendingError(error.toolCallId);
    throw error;
  }
}

export async function decisionsOf(harness: Harness, conversationId: ConversationId): Promise<Decisions> {
  return (await harness.snapshot(ApprovalsDoc, conversationId, context))?.decisions ?? {};
}
