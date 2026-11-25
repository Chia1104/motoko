import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc } from "@earendil-works/pi-durable";
import type { Cursor, EntryRecord, HookApi, InputEntry, JsonObject } from "@earendil-works/pi-durable";

import { INPUT_ENTRY, isInput, joinsRun, STEER_ENTRY } from "./transcriber.ts";

/** An input of the run going on, as `runInputs` reads it back. */
export interface RunInput {
  readonly entryId: number;
  /** Its user message's timestamp, by which `locateInputs` finds it. One boundary gives its inputs one time. */
  readonly at: number;
  /** Whether it joined the run after one of its tool rounds, as its `user` event's `steer` says. */
  readonly steer: boolean;
  /** What it was submitted with. */
  readonly metadata?: JsonObject;
}

/** An input of the run going on, with where `locateInputs` found its user message. */
export interface LocatedInput extends RunInput {
  /** Its user message's position in the messages; undefined when they do not hold it: compacted, or dropped by a hook. */
  readonly index: number | undefined;
}

/**
 * The entry `submit` places an input as: a steer as `motoko.steer`, any other input with metadata as `motoko.input`,
 * either holding `{ metadata }`; undefined for pi-durable's `pi.user`.
 */
export function inputEntry(steer: boolean, metadata: JsonObject | undefined): InputEntry | undefined {
  const data = metadata === undefined ? undefined : { metadata };
  if (steer) return { kind: STEER_ENTRY, ...(data !== undefined && { data }) };
  return data === undefined ? undefined : { kind: INPUT_ENTRY, data };
}

const PAGE = 200;

/**
 * The inputs of the run going on, in entry order, from `pi.live`'s `run.first`: for a continue, the failed run's it
 * carries on. For an app hook, such as `beforeRequest`, which reads them from committed entries, so a run resumed
 * after a restart reads the same. Empty with no run going.
 */
export async function runInputs(api: HookApi, context: Context): Promise<readonly RunInput[]> {
  const first = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.first;
  if (first === undefined) return [];
  const inputs: RunInput[] = [];
  let previous: EntryRecord | undefined;
  let reply: EntryRecord | undefined;
  let steered = false;
  let cursor: Cursor | undefined;
  do {
    const page = await api.entries({ minEntryId: first, order: "ascending" }, PAGE, cursor, context);
    for (const entry of page.items) {
      const [message] = entry.model ?? [];
      if (isInput(entry) && message?.role === "user") {
        const joined = entry.id === first ? undefined : joinsRun(entry, previous, reply);
        steered = joined === "steer" || (joined === "with" && steered);
        // SAFETY: an input's entry holds what `inputEntry` placed: `{ metadata }`, or no data.
        const metadata = (entry.data as { readonly metadata?: JsonObject } | undefined)?.metadata;
        inputs.push({
          entryId: entry.id,
          at: message.timestamp,
          steer: steered,
          ...(metadata !== undefined && { metadata }),
        });
      }
      if (AssistantEntry.is(entry)) reply = entry;
      previous = entry;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return inputs;
}

/**
 * Where each of the run's inputs has its user message in `messages`, such as `beforeRequest`'s: the user message with
 * its time. It matches from the end, as the run's inputs are the newest user messages, so an earlier run's message of
 * the same time is not taken; inputs that share a time take that time's messages in entry order. The inputs come back
 * in the order given.
 */
export function locateInputs(messages: readonly Message[], inputs: readonly RunInput[]): readonly LocatedInput[] {
  const located: LocatedInput[] = [];
  // Each input's message comes before the message of the input after it.
  let end = messages.length;
  for (const input of inputs.toReversed()) {
    const index = messages.findLastIndex(
      (message, position) => position < end && message.role === "user" && message.timestamp === input.at,
    );
    if (index >= 0) end = index;
    located.push({ ...input, index: index >= 0 ? index : undefined });
  }
  return located.reverse();
}
