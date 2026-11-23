import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

// A type alias, not an interface: the document must be a pi `JsonObject`, and only an alias has the implicit index
// signature that takes.
// oxlint-disable-next-line typescript/consistent-type-definitions
type CallRecord = {
  /**
   * The call's tool task. A model may name two calls of one conversation alike, so a record speaks for the call whose
   * task it names, and for no later one under its id.
   */
  taskId: number;
} & (
  | {
      kind: "delegate";
      /** The child session the call runs its sub-agent in. */
      sessionId: string;
    }
  | {
      kind: "reply";
      /** What a reply must carry: the reply address's token, which only the work the call started knows. */
      token: string;
      /** Epoch ms of the call's deadline. */
      until: number;
      /** Epoch ms the reply was delivered: a later one is `already_replied`. */
      repliedAt?: number;
    }
);

/** The calls of a conversation the runtime runs itself, by tool call id. */
export type Calls = Readonly<Record<string, CallRecord>>;

/** The record of call `callId` run by task `taskId`, if that call has started: not an earlier call's of the same id. */
export function startedCall(calls: Calls, callId: string, taskId: number | undefined): CallRecord | undefined {
  const record = calls[callId];
  return record !== undefined && record.taskId === taskId ? record : undefined;
}

/**
 * The record of a conversation's calls that the runtime runs itself and that have started: a delegate's, from the
 * commit that makes its child session, and a deferred call's, from the commit before its `start`. A call listed here
 * has passed its gate, so a call that sleeps while listed is parked on its own work, not waiting for a decision.
 */
export const CallsDoc = defineDoc<{ calls: Record<string, CallRecord> }>({
  kind: "runtime.calls",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ calls: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** The started calls of conversation `conversationId`, by call id. */
export async function callsOf(harness: Harness, conversationId: ConversationId): Promise<Calls> {
  return (await harness.snapshot(CallsDoc, conversationId, context))?.calls ?? {};
}
