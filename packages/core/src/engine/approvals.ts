import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, defineSignal, hook, LiveDoc, ToolTask } from "@earendil-works/pi-durable";
import type { ConversationId, Harness, HookRegistration, JsonObject, TaskId } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";

import type { AgentDefinition } from "../agent.ts";
import { ApprovalNotPendingError } from "../errors.ts";

import { callsOf, startedCall } from "./calls.ts";
import { MODEL_ARGS } from "./extensions.ts";
import type { GatedTool } from "./extensions.ts";
import { SessionsDoc } from "./sessions.ts";
import type { ApprovalRule } from "./sessions.ts";

/**
 * The approval gate: a call of a tool whose tier the agent's policy gates waits for an operator's
 * decision before it runs. The signal decides the call; `ApprovalsDoc` records the decision, which is
 * what a transcript replays, since a signal is readable only while its task lives. `decide` commits
 * both in one transaction, so a decision is never delivered without its record, nor recorded without
 * being delivered. A session may carry its own rule (`SessionsDoc`); the gate reads it at each pass.
 */

const context = BACKGROUND_CONTEXT;

export interface ApprovalDecision {
  readonly toolCallId: string;
  readonly approved: boolean;
  /** Returned to the model as the call's result when the call is declined. */
  readonly comment?: string;
}

export interface ApprovalOutcome {
  readonly toolCallId: string;
  readonly outcome: "applied" | "already_decided";
}

/**
 * The operator's decision on a gated call, delivered to the call's tool task under the call's id. It
 * is kept in the task record, so a decision survives a restart and a gate that reruns reads the same one.
 */
const ApprovalSignal = defineSignal({
  name: "runtime.approval",
  version: 1,
  schema: obj({ approved: bool(), comment: opt(str()) }),
});

// A type alias, not an interface: the decisions document must be a pi `JsonObject`, and only an alias has the
// implicit index signature that takes.
// oxlint-disable-next-line typescript/consistent-type-definitions
type StoredDecision = {
  approved: boolean;
  comment?: string;
  /**
   * The arguments the gate saw when the call parked, which the call runs with: what the operator was asked about.
   * Absent for a call decided before it parked, and in a decision an earlier Motoko recorded.
   */
  args?: JsonObject;
  /** Epoch ms the decision was committed. */
  at: number;
};

/** The decisions made in a conversation, by tool call id. */
export type Decisions = Readonly<Record<string, StoredDecision>>;

/** The record of a conversation's decisions. Internal: exported for the tests that commit one as `decide` does. */
export const ApprovalsDoc = defineDoc<{ decisions: Record<string, StoredDecision> }>({
  kind: "runtime.approvals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ decisions: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/**
 * Whether a call of `tool` in a session of `agent` needs approval: under the session's `rule` when it has one, else
 * under the agent's policy. A tool of unknown tier always does, whatever either says.
 */
export function isGated(agent: AgentDefinition, tool: GatedTool, rule?: ApprovalRule): boolean {
  const { tier, name } = tool;
  if (tier === undefined) return true;
  if (rule === undefined) return agent.policy.requiresApproval(tier, name);
  if (Array.isArray(rule)) return rule.includes(tier);
  const { add, remove } = rule as Exclude<ApprovalRule, readonly string[]>;
  if (remove?.includes(tier)) return false;
  return add?.includes(tier) === true || agent.policy.requiresApproval(tier, name);
}

/** The approval rule of session `conversationId`, if it has its own, from what `snapshot` reads of the sessions record. */
export function ruleOf(
  sessions: Readonly<{ sessions: Readonly<Record<string, { readonly requiresApproval?: ApprovalRule }>> }> | undefined,
  conversationId: ConversationId,
): ApprovalRule | undefined {
  return sessions?.sessions[String(conversationId)]?.requiresApproval;
}

/**
 * The gate's memo of the arguments it saw when a call first parked. The gate runs last in the chain, after every app
 * hook, so these are the arguments the call runs with. A memo lives on the call's tool task while the task can run.
 */
const GATE_ARGS = "motoko.gate.args";

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether two JSON values are equal, whatever the order of their objects' keys (a JSON column may reorder them). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  // SAFETY: both are JSON objects or arrays, whose members `Object.keys` lists.
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length && keys.every((key) => Object.hasOwn(y, key) && sameJson(x[key], y[key]))
  );
}

/** The arguments the gate saw when call task `taskId` parked at it; undefined if it never parked, or once it ended. */
export async function gateArgsOf(harness: Harness, taskId: TaskId): Promise<JsonObject | undefined> {
  const args = (await harness.getTask(taskId, context))?.memos?.[GATE_ARGS];
  return isObject(args) ? args : undefined;
}

function declineText(comment: string | undefined): string {
  return comment === undefined || comment.trim().length === 0
    ? "The operator declined this call."
    : `The operator declined this call: ${comment}`;
}

/**
 * The gate, as the agent's extension installs it: a `beforeTool` hook that parks a gated call on
 * `ApprovalSignal` under the call's id. The park is the call's task state, so nothing waits in memory:
 * a restart, a registry change or the decision's arrival runs the gate again from the top, and it
 * passes, blocks, or parks again. A decision, once delivered, decides the call whatever the session's
 * rule says by then, so a rule changed while the call waited neither runs a declined call nor drops its
 * question. A declined call is blocked, and `afterTool` hands the model the operator's comment as the
 * call's result. It judges every call of a session of `agent`, the app's tools' too, as `toolOf` knows them.
 *
 * When a call first parks, the gate memoizes the arguments it sees (`GATE_ARGS`): those the operator is asked about.
 * An approved call whose arguments are not those any more is blocked. The app hooks' memos keep their rewrites fixed,
 * so this should never happen; it is the last check that the operator approved what runs. A call decided before it
 * parked has no such memo: the operator was asked about the model's arguments, so it is blocked if an app hook rewrote
 * them (`MODEL_ARGS`).
 */
export function approvalGate(agent: AgentDefinition, toolOf: (name: string) => GatedTool): HookRegistration {
  return hook(ToolTask, {
    async beforeTool(call, api, context) {
      const state = await api.readSignal(ApprovalSignal, call.id, context);
      if (state !== undefined) {
        if ("expired" in state) return { block: "No decision arrived for this call." };
        if (!state.value.approved) return { block: declineText(state.value.comment) };
        const asked =
          (await api.memo<JsonObject>(GATE_ARGS, context)) ?? (await api.memo<JsonObject>(MODEL_ARGS, context));
        return asked === undefined || sameJson(asked, call.arguments)
          ? undefined
          : { block: "The call's arguments changed after the operator was asked about it." };
      }
      const rule = ruleOf(await api.snapshot(SessionsDoc, context), api.conversationId);
      if (!isGated(agent, toolOf(call.name), rule)) return undefined;
      // SAFETY: pi-ai's JSON arguments differ from pi-durable's JSON only in typing their arrays readonly.
      await api.memo(GATE_ARGS, call.arguments as JsonObject, context);
      return { sleep: { signals: [ApprovalSignal.key(call.id)] } };
    },
    async afterTool(call, result, api, context) {
      if (!result.diagnostics?.some((diagnostic) => diagnostic.code === "blocked")) return undefined;
      const state = await api.readSignal(ApprovalSignal, call.id, context);
      if (state === undefined || !("value" in state) || state.value.approved) return undefined;
      // The model reads the operator's words, not the harness's report of a blocked call.
      return {
        output: [{ type: "text", text: declineText(state.value.comment) }],
        isError: true,
        diagnostics: [],
      };
    },
  });
}

/** A decision `decide` refuses inside its transaction, which undoes the transaction's other decisions. */
class Refused extends Error {
  readonly toolCallId: string;
  constructor(toolCallId: string) {
    super(toolCallId);
    this.toolCallId = toolCallId;
  }
}

/**
 * Decides calls of conversation `conversationId`, all in one transaction: every decision is delivered and recorded,
 * each with the arguments the gate saw when the call parked, or none is. A call a decision reached first is
 * `already_decided`. Rejects with `ApprovalNotPendingError`, committing nothing, if any call is not waiting at the gate:
 * neither parked there nor about to reach it, as `gated` judges a tool by name under the session's rule. A call that
 * sleeps after it started, such as a delegate's waiting for its child, is parked on its own work. A call named twice is
 * a `TypeError`.
 */
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
    const slot = live?.tools?.find((candidate) => candidate.callId === decision.toolCallId);
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
      // The memos go with their tasks, so the records keep what the operator was asked about. Read before any write:
      // a transaction reads no table after its first write.
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
    // A callback that throws discards its transaction: none of the batch was delivered.
    if (error instanceof Refused) throw new ApprovalNotPendingError(error.toolCallId);
    throw error;
  }
}

/** The decisions recorded in conversation `conversationId`, by call id. */
export async function decisionsOf(harness: Harness, conversationId: ConversationId): Promise<Decisions> {
  return (await harness.snapshot(ApprovalsDoc, conversationId, context))?.decisions ?? {};
}
