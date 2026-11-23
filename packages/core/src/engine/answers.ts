import type { Message } from "@earendil-works/pi-ai";
import type { EntryId, SignalToken, SubmissionSettled } from "@earendil-works/pi-durable";

/** A submission's settled record, as `SubmissionSettled` delivers it. */
export type Settled = typeof SubmissionSettled extends SignalToken<infer T> ? T : never;

/** What another agent's run answered, as the call that waited for it returns it. */
export interface Answer {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * The answer of the run that settled `record`: its last reply's text, or why there is none. `read` reads the answer's
 * entry, and `who` names the agent in what the model reads.
 */
export async function answerOf(
  record: Settled,
  read: (id: EntryId) => Promise<{ readonly model?: readonly Message[] } | undefined>,
  who: string,
): Promise<Answer> {
  const answered = record.status === "done" ? record.answer : undefined;
  if (answered === undefined) {
    const detail = typeof record.detail === "string" ? `: ${record.detail}` : "";
    return { text: `${who} ended without an answer (${record.reason}${detail}).`, isError: true };
  }
  const [message] = (await read(answered))?.model ?? [];
  if (message?.role !== "assistant") return { text: `${who}'s answer could not be read.`, isError: true };
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { text: `${who}'s answer failed: ${message.errorMessage ?? message.stopReason}`, isError: true };
  }
  const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  return { text, isError: false };
}
