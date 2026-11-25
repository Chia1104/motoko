import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

export type EpochMs = number;

// This is a type alias, not an interface, because the document must be a pi `JsonObject`, and only an alias has the
// implicit index signature that `JsonObject` takes.
// oxlint-disable-next-line typescript/consistent-type-definitions
type CallRecord = {
  /**
   * A model may give two calls of one conversation the same id, so a record holds only for the call whose task it
   * names.
   */
  taskId: number;
} & (
  | {
      kind: "delegate";
      sessionId: string;
    }
  | {
      kind: "reply";
      token: string;
      until: EpochMs;
      repliedAt?: EpochMs;
    }
  | {
      kind: "app";
    }
);

export type Calls = Readonly<Record<string, CallRecord>>;

export function startedCall(calls: Calls, callId: string, taskId: number | undefined): CallRecord | undefined {
  const record = calls[callId];
  return record !== undefined && record.taskId === taskId ? record : undefined;
}

export const CallsDoc = defineDoc<{ calls: Record<string, CallRecord> }>({
  kind: "runtime.calls",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ calls: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export async function callsOf(harness: Harness, conversationId: ConversationId): Promise<Calls> {
  return (await harness.snapshot(CallsDoc, conversationId, context))?.calls ?? {};
}
