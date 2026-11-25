import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineSignal, LiveDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { bool, obj, str } from "@earendil-works/pi-schema";

import { ReplyNotPendingError } from "../errors.ts";

import { CallsDoc, startedCall } from "./calls.ts";

const context = BACKGROUND_CONTEXT;

export const ReplySignal = defineSignal({
  name: "runtime.reply",
  version: 1,
  schema: obj({ text: str(), isError: bool() }),
});

export const REPLY_KEY = "reply";

export interface ReplyInput {
  readonly toolCallId: string;
  readonly token: string;
  /** What the call returns, which the model reads. */
  readonly text: string;
  /** Whether the call returns an error result. Default: false. */
  readonly isError?: boolean;
}

export interface ReplyResult {
  readonly outcome: "applied" | "already_replied";
}

export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(expected: string, given: string): boolean {
  let diff = expected.length ^ given.length;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ (given.charCodeAt(index) || 0);
  }
  return diff === 0;
}

export async function applyReply(
  harness: Harness,
  conversationId: ConversationId,
  input: ReplyInput,
): Promise<ReplyResult> {
  const { toolCallId } = input;
  const live = await harness.snapshot(LiveDoc, conversationId, context);
  const taskId = live?.tools?.find((slot) => slot.callId === toolCallId)?.taskId;
  return harness.commit(async (tx): Promise<ReplyResult> => {
    // Read the documents first, because `tx.signal` reads the task, and that read must come before the commit's first
    // table write.
    const calls = await tx.doc(CallsDoc, conversationId);
    const record = calls.calls[toolCallId];
    if (record?.kind !== "reply" || !constantTimeEqual(record.token, input.token))
      throw new ReplyNotPendingError(toolCallId);
    if (record.repliedAt !== undefined) return { outcome: "already_replied" };
    if (taskId === undefined || startedCall(calls.calls, toolCallId, taskId) !== record) {
      throw new ReplyNotPendingError(toolCallId);
    }
    const delivered = await tx.signal(taskId, ReplySignal, REPLY_KEY, {
      text: input.text,
      isError: input.isError ?? false,
    });
    if (delivered === "duplicate") return { outcome: "already_replied" };
    if (delivered !== "delivered") throw new ReplyNotPendingError(toolCallId);
    record.repliedAt = Date.now();
    return { outcome: "applied" };
  }, context);
}
