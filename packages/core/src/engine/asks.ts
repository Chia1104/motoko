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

/**
 * Asks: submissions that carry a reply address. Each has a courier, a background task of the asked conversation that
 * waits for the submission to settle and delivers the run's answer to the address through the app's `deliverReply`,
 * trying again until it lands or a day has passed.
 */

const context = BACKGROUND_CONTEXT;

/** What the asked runtime hands `deliverReply`: where the reply goes, and the reply. */
export interface OutgoingReply {
  readonly to: ReplyAddress;
  readonly text: string;
  readonly isError: boolean;
}

/** Resolves once the reply landed or was refused for good; rejects to be called again later. */
export type DeliverReply = (reply: OutgoingReply, signal: AbortSignal) => Promise<void>;

/** How a courier tries again. Only tests shorten it. */
export interface CourierTiming {
  /** The wait after the first failed delivery; it doubles after each. */
  readonly firstMs: number;
  readonly maxMs: number;
  /** The courier gives up this long after its first delivery. */
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
  /** Nothing is tried again. */
  readonly gaveUp: boolean;
  readonly error: unknown;
}

/** The asks of a conversation whose courier is at work, by request ID: what a retried `submit` finds. */
export const AsksDoc = defineDoc<{ asks: Record<string, { taskId: number }> }>({
  kind: "runtime.asks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ asks: {} }),
  checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

/** The key a courier waits for its submission's settlement under. */
const SETTLED = "settled";

// Type aliases, not interfaces: a task's input and checkpoint must be pi `JsonValue`s.
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

const draftOf = (input: AskInput, courier: TaskId) =>
  ({
    type: "input",
    content: input.text,
    requestId: input.requestId,
    notify: { taskId: courier, key: SETTLED },
  }) as const;

const addressOf = ({ token: _token, ...to }: ReplyAddress) => to;

type CourierRuntime = TaskRuntime<AskInput, CourierState, null, object>;

/** The courier's end, with its ask forgotten: a retried `submit` of it is then a plain one. */
async function forget(tx: Tx, conversationId: ConversationId, requestId: string) {
  delete (await tx.doc(AsksDoc, conversationId)).asks[requestId];
}

const finish = (runtime: CourierRuntime, requestId: string, ctx: Context) =>
  runtime.commit(async (tx): Promise<NextTaskState<CourierState, null>> => {
    await forget(tx, runtime.conversationId, requestId);
    return { status: "terminal", outcome: { status: "completed", result: null } };
  }, ctx);

/** The courier task of an instance's asks, delivering through `deliver`, and the extension that installs it. */
export function askCourier({ deliver, timing, failed }: CourierOptions): { courier: Courier; extension: Extension } {
  const courier: Courier = defineTask<AskInput, CourierState, null>({
    name: "runtime.ask",
    version: 1,
    initial: () => ({ phase: "submit" }),
    phases: {
      /**
       * Submits the ask itself, in the commit that parks it on the settlement: `submit` makes the same submission
       * right after the courier, and a crash between the two leaves this one to make it.
       */
      submit: async (task, runtime, ctx) => {
        const { conversationId } = runtime;
        // SAFETY: a task's own conversation outlives it.
        const conversation = (await runtime.conversation(conversationId, ctx))!;
        let stray = false;
        await runtime.commit(async (tx): Promise<NextTaskState<CourierState, null>> => {
          const existing = await tx.submissionByRequest(conversationId, task.input.requestId);
          if (existing !== undefined && (existing.notify?.taskId !== task.id || existing.notify.key !== SETTLED)) {
            // The request was submitted without a reply address first: its settlement reaches no courier.
            stray = true;
            await forget(tx, conversationId, task.input.requestId);
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          await conversation.submit(tx, draftOf(task.input, task.id));
          return { status: "sleeping", signals: [SubmissionSettled.key(SETTLED)], checkpoint: { phase: "answer" } };
        }, ctx);
        if (!stray) return;
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
          // The instance closes: this phase runs again once it reopens.
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
    // A deleted asked session aborts its courier. Nothing is delivered: the asker's deadline ends its call.
    abort: (task, runtime, ctx) =>
      runtime.commit(async (tx): Promise<NextTaskState<CourierState, null>> => {
        await forget(tx, runtime.conversationId, task.input.requestId);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx),
  });
  return { courier, extension: defineExtension({ name: "runtime:asks", tasks: [courier] }) };
}

/**
 * Submits `text` to `conversation` as an ask: in one commit, the courier (found again for a retried request, or none
 * for a request first submitted without a reply address); then the submission, which notifies the courier when it
 * settles. A retry returns the first submission.
 */
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
    // SAFETY: the record holds the id of a task the runtime created.
    if (known !== undefined) return known.taskId as TaskId;
    if ((await tx.submissionByRequest(id, input.requestId)) !== undefined) return undefined;
    const created = await tx.createTask(courier, input, {
      ownership: { kind: "conversation" },
      conversationId: id,
      background: true,
    });
    asks.asks[input.requestId] = { taskId: created };
    return created;
  }, context);
  const draft =
    taskId === undefined
      ? ({ type: "input", content: input.text, requestId: input.requestId } as const)
      : draftOf(input, taskId);
  return (await conversation.submit(draft, context)).id;
}
