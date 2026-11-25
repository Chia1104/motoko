import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, defineDoc, defineExtension, defineTask, SubmissionSettled } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  EntryId,
  Extension,
  Harness,
  NextTaskState,
  SubmissionId,
  Task,
  TaskId,
  TaskRuntime,
  Tx,
} from "@earendil-works/pi-durable";

import type { ReplyAddress } from "@chia1104/motoko-wire";

import { answerOf } from "./answers.ts";

const context = BACKGROUND_CONTEXT;

/** What the asked runtime hands `deliverReply`: where the reply goes, and the reply. */
export interface OutgoingReply {
  readonly to: ReplyAddress;
  readonly text: string;
  readonly isError: boolean;
}

/** Resolves once the reply landed or was refused for good; rejects to be called again later. */
export type DeliverReply = (reply: OutgoingReply, signal: AbortSignal) => Promise<void>;

export interface CourierTiming {
  readonly firstMs: number;
  readonly maxMs: number;
  readonly giveUpMs: number;
}

export const COURIER_TIMING: CourierTiming = { firstMs: 1_000, maxMs: 5 * 60_000, giveUpMs: 24 * 60 * 60_000 };

/** A delivery that failed, or a reply that can never be sent. */
export interface ReplyFailure {
  readonly sessionId: string;
  readonly requestId: string;
  /** Where the reply goes, without its token. */
  readonly to: Omit<ReplyAddress, "token">;
  /** The delivery that failed, from 1; 0 when none was tried. */
  readonly attempt: number;
  /** The courier tries no more deliveries. */
  readonly gaveUp: boolean;
  readonly error: unknown;
}

export const AsksDoc = defineDoc<{ asks: Record<string, { taskId: TaskId }> }>({
  kind: "runtime.asks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ asks: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

const SETTLED = "settled";

// These are type aliases, not interfaces, because a task's input and checkpoint must be pi `JsonValue`s.
// oxlint-disable-next-line typescript/consistent-type-definitions
type AskInput = { requestId: string; text: string; replyTo: ReplyAddress };
// oxlint-disable-next-line typescript/consistent-type-definitions
type CourierState =
  | { phase: "submit" }
  | { phase: "answer" }
  | { phase: "deliver"; reply: { text: string; isError: boolean }; attempt: number; since: number };

export type Courier = Task<AskInput, CourierState, null, object>;

interface CourierOptions {
  readonly deliver: DeliverReply | undefined;
  readonly timing: () => CourierTiming;
  readonly failed: (failure: ReplyFailure) => void;
}

const draftDedupedByRequestId = (input: AskInput, courier: TaskId | undefined) =>
  ({
    type: "input",
    content: input.text,
    requestId: input.requestId,
    ...(courier !== undefined && { notify: { taskId: courier, key: SETTLED } }),
  }) as const;

const addressOf = ({ token: _token, ...to }: ReplyAddress) => to;

type CourierRuntime = TaskRuntime<AskInput, CourierState, null, object>;

async function forget(tx: Tx, conversationId: ConversationId, requestId: string) {
  delete (await tx.doc(AsksDoc, conversationId)).asks[requestId];
}

const finish = (runtime: CourierRuntime, requestId: string, ctx: Context) =>
  runtime.commit(async (tx): Promise<NextTaskState<CourierState, null>> => {
    await forget(tx, runtime.conversationId, requestId);
    return { status: "terminal", outcome: { status: "completed", result: null } };
  }, ctx);

export function askCourier({ deliver, timing, failed }: CourierOptions): { courier: Courier; extension: Extension } {
  const courier: Courier = defineTask<AskInput, CourierState, null>({
    name: "runtime.ask",
    version: 1,
    initial: () => ({ phase: "submit" }),
    phases: {
      submit: async (task, runtime, ctx) => {
        const { conversationId } = runtime;
        // SAFETY: a task's own conversation outlives it.
        const conversation = (await runtime.conversation(conversationId, ctx))!;
        let firstSubmittedWithoutReplyAddress = false;
        await runtime.commit(async (tx): Promise<NextTaskState<CourierState, null>> => {
          const existing = await tx.submissionByRequest(conversationId, task.input.requestId);
          if (existing !== undefined && (existing.notify?.taskId !== task.id || existing.notify.key !== SETTLED)) {
            firstSubmittedWithoutReplyAddress = true;
            await forget(tx, conversationId, task.input.requestId);
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          await conversation.submit(tx, draftDedupedByRequestId(task.input, task.id));
          return { status: "sleeping", signals: [SubmissionSettled.key(SETTLED)], checkpoint: { phase: "answer" } };
        }, ctx);
        if (!firstSubmittedWithoutReplyAddress) return;
        failed({
          sessionId: String(conversationId),
          requestId: task.input.requestId,
          to: addressOf(task.input.replyTo),
          attempt: 0,
          gaveUp: true,
          error: new Error(`Request ${task.input.requestId} was submitted without a reply address first`),
        });
      },
      answer: async (task, runtime, ctx) => {
        const settled = await runtime.readSignal(SubmissionSettled, SETTLED, ctx);
        const read = (id: EntryId) => runtime.entry(AssistantEntry, id, ctx);
        const answer =
          settled !== undefined && "value" in settled
            ? await answerOf(settled.value, read, "The asked agent")
            : { text: "The asked agent never answered.", isError: true };
        const reply = { text: answer.text, isError: answer.isError };
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "deliver", reply, attempt: 1, since: runtime.now() } }),
          ctx,
        );
      },
      deliver: async (task, runtime, ctx) => {
        const { requestId, replyTo } = task.input;
        const { reply, attempt, since } = task.state.checkpoint;
        try {
          if (deliver === undefined) throw new Error("This runtime has no `deliverReply`");
          await deliver({ to: replyTo, ...reply }, runtime.signal);
        } catch (error) {
          // The instance is closing, and this phase runs again once it reopens.
          if (runtime.signal.aborted) throw error;
          const { firstMs, maxMs, giveUpMs } = timing();
          const gaveUp = runtime.now() - since >= giveUpMs;
          const sessionId = String(runtime.conversationId);
          failed({ sessionId, requestId, to: addressOf(replyTo), attempt, gaveUp, error });
          if (gaveUp) {
            await finish(runtime, requestId, ctx);
            return;
          }
          const until = runtime.now() + Math.min(firstMs * 2 ** (attempt - 1), maxMs);
          await runtime.commit(
            () => ({ status: "sleeping", until, checkpoint: { phase: "deliver", reply, attempt: attempt + 1, since } }),
            ctx,
          );
          return;
        }
        await finish(runtime, requestId, ctx);
      },
    },
    abort: (task, runtime, ctx) =>
      runtime.commit(async (tx): Promise<NextTaskState<CourierState, null>> => {
        await forget(tx, runtime.conversationId, task.input.requestId);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx),
  });
  return { courier, extension: defineExtension({ name: "runtime:asks", tasks: [courier] }) };
}

export async function ask(
  harness: Harness,
  conversation: Conversation,
  courier: Courier,
  input: AskInput,
): Promise<SubmissionId> {
  const { id } = conversation;
  const taskId = await harness.commit(async (tx): Promise<TaskId | undefined> => {
    const asks = await tx.doc(AsksDoc, id);
    const known = asks.asks[input.requestId];
    if (known !== undefined) return known.taskId;
    if ((await tx.submissionByRequest(id, input.requestId)) !== undefined) return undefined;
    const created = await tx.createTask(courier, input, {
      ownership: { kind: "conversation" },
      conversationId: id,
      background: true,
    });
    asks.asks[input.requestId] = { taskId: created };
    return created;
  }, context);
  return (await conversation.submit(draftDedupedByRequestId(input, taskId), context)).id;
}
