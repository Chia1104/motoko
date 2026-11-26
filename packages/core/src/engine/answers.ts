import type { Message } from "@earendil-works/pi-ai";
import type { EntryId, SignalToken, SubmissionSettled } from "@earendil-works/pi-durable";

export type Settled = typeof SubmissionSettled extends SignalToken<infer T> ? T : never;

export interface Answer {
  readonly text: string;
  readonly isError: boolean;
}

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
