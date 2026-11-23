import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineSignal, LiveDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { bool, obj, str } from "@earendil-works/pi-schema";

import { ReplyNotPendingError } from "../errors.ts";

import { CallsDoc, startedCall } from "./calls.ts";

/**
 * Replies: the answer that reaches a deferred call at its reply address. The call parks on `ReplySignal` under one key;
 * `reply` delivers the signal and records it in `CallsDoc` in one commit, so a reply is delivered at most once and a
 * second one is told so.
 */

const context = BACKGROUND_CONTEXT;

/** The reply, delivered to the deferred call's tool task. It is kept in the task record, so it survives a restart. */
export const ReplySignal = defineSignal({
  name: "runtime.reply",
  version: 1,
  schema: obj({ text: str(), isError: bool() }),
});

/** The one key a deferred call waits under: each call waits for one reply. */
export const REPLY_KEY = "reply";

export interface ReplyInput {
  readonly toolCallId: string;
  readonly token: string;
  /** What the call returns, which the model reads. */
  readonly text: string;
  /** The call returns an error result. Default: false. */
  readonly isError?: boolean;
}

export interface ReplyResult {
  readonly outcome: "applied" | "already_replied";
}

/** A fresh reply token: 192 random bits, hex. */
export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether `given` is `expected`, in a time that depends on `expected` alone, so a guess learns nothing from it. */
function sameToken(expected: string, given: string): boolean {
  let diff = expected.length ^ given.length;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ (given.charCodeAt(index) || 0);
  }
  return diff === 0;
}

/**
 * Delivers a reply to call `toolCallId` of conversation `conversationId`, in one commit with its record. The call may be
 * parked on it, or still running towards its park: a reply that comes first is kept and wakes the park at once.
 * Rejects with `ReplyNotPendingError`, committing nothing, for a call that waits for no reply, has ended, or whose
 * token is another.
 */
export async function applyReply(
  harness: Harness,
  conversationId: ConversationId,
  input: ReplyInput,
): Promise<ReplyResult> {
  const { toolCallId } = input;
  const live = await harness.snapshot(LiveDoc, conversationId, context);
  const taskId = live?.tools?.find((slot) => slot.callId === toolCallId)?.taskId;
  return harness.commit(async (tx): Promise<ReplyResult> => {
    // Documents first: `tx.signal` reads the task, which must come before the commit's first table write.
    const calls = await tx.doc(CallsDoc, conversationId);
    const record = calls.calls[toolCallId];
    if (record?.kind !== "reply" || !sameToken(record.token, input.token)) throw new ReplyNotPendingError(toolCallId);
    // The live call under this id is the record's only if it runs the record's task: a later call may reuse the id.
    // A delivery retried after the call took its reply and ended is told so, too.
    if (record.repliedAt !== undefined) return { outcome: "already_replied" };
    if (taskId === undefined || startedCall(calls.calls, toolCallId, taskId) !== record) {
      throw new ReplyNotPendingError(toolCallId);
    }
    const delivered = await tx.signal(taskId, ReplySignal, REPLY_KEY, {
      text: input.text,
      isError: input.isError ?? false,
    });
    if (delivered === "duplicate") return { outcome: "already_replied" };
    // The call ended, was aborted, or its deadline passed first.
    if (delivered !== "delivered") throw new ReplyNotPendingError(toolCallId);
    record.repliedAt = Date.now();
    return { outcome: "applied" };
  }, context);
}
