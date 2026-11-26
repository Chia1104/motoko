import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc } from "@earendil-works/pi-durable";
import type { Cursor, EntryRecord, HookApi, InputEntry, JsonObject } from "@earendil-works/pi-durable";

import { isObject } from "./approvals.ts";
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
  /**
   * Its user message's position in the messages, or undefined when they do not hold it because it was compacted or a
   * hook dropped it.
   */
  readonly index: number | undefined;
}

export function inputEntry(steer: boolean, metadata: JsonObject | undefined): InputEntry | undefined {
  const data = metadata === undefined ? undefined : { metadata };
  if (steer) return { kind: STEER_ENTRY, ...(data !== undefined && { data }) };
  return data === undefined ? undefined : { kind: INPUT_ENTRY, data };
}

function metadataOf(entry: EntryRecord): JsonObject | undefined {
  const metadata = isObject(entry.data) ? entry.data.metadata : undefined;
  return isObject(metadata) ? metadata : undefined;
}

const PAGE = 200;

/**
 * The inputs of the run going on, in entry order, from `pi.live`'s `run.first`. For a continue, `run.first` belongs to
 * the failed run it carries on. It is for an app hook such as `beforeRequest`. It reads committed entries, so a run
 * resumed after a restart reads the same inputs. Empty with no run going.
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
        const metadata = metadataOf(entry);
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
 * Where each of the run's inputs has its user message in `messages`, such as `beforeRequest`'s. An input's user
 * message is the user message with its time. It matches from the end, because the run's inputs are the newest user
 * messages, so it never takes an earlier run's message of the same time. Inputs that share a time take that time's
 * messages in entry order. The inputs come back in the order given.
 */
export function locateInputs(messages: readonly Message[], inputs: readonly RunInput[]): readonly LocatedInput[] {
  const located: LocatedInput[] = [];
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
