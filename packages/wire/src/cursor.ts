import * as z from "zod";

import { agentWireEventSchema } from "./events.ts";
import type { AgentWireEvent } from "./events.ts";

/**
 * A position in one session's event stream: the point right after an event. Opaque to clients, who
 * store the last one they folded and hand it back to resume.
 *
 * It names committed state, so it outlives the process that handed it out: the session, the newest
 * stored entry whose events the client has folded, and the run the client is in. A cursor from the
 * current run of a live stream also names its place in the server's in-memory log of that run, so
 * resuming in the same process is exact, event for event. Anywhere else (after a restart, in another
 * process on the same storage, or once that log is gone) the server sends the events of what was
 * committed after the entry, then the current in-flight state, which fold into the view a client
 * connected all along has.
 */
export type Cursor = string & { readonly __brand: "Cursor" };

export interface CursorPosition {
  /** The session the stream is of. */
  readonly session: string;
  /** The newest stored entry whose events the client has, all of them; 0 before the first. */
  readonly entry: number;
  /**
   * The run the client is in: the entry of the user message that started it, or `"*"` for a run
   * that started without one. Absent while the client sees no run going.
   */
  readonly run?: number | "*";
  /** The cursor's place in one server log: the log's `epoch` and the event's sequence number in it. */
  readonly log?: { readonly epoch: string; readonly seq: number };
}

const NUMBER = "(?:0|[1-9]\\d{0,15})";
const CURSOR = new RegExp(
  `^([A-Za-z0-9_-]{1,64})\\.(${NUMBER})\\.(-|\\*|[1-9]\\d{0,15})(?:\\.([a-z0-9]{1,32})\\.(${NUMBER}))?$`,
);

export const cursorSchema = z
  .string()
  .regex(CURSOR, "Not a Motoko cursor")
  .transform((value) => value as Cursor);

export function encodeCursor(position: CursorPosition): Cursor {
  const run = position.run === undefined ? "-" : String(position.run);
  const log = position.log === undefined ? "" : `.${position.log.epoch}.${position.log.seq}`;
  const cursor = `${position.session}.${position.entry}.${run}${log}`;
  if (!CURSOR.test(cursor)) throw new Error(`Invalid cursor position ${cursor}`);
  return cursor as Cursor;
}

/** `undefined` for a string that is not a cursor. */
export function decodeCursor(cursor: string): CursorPosition | undefined {
  const match = CURSOR.exec(cursor);
  if (!match) return undefined;
  const [, session, entry, run, epoch, seq] = match;
  return {
    session: session!,
    entry: Number(entry),
    ...(run !== "-" && { run: run === "*" ? "*" : Number(run) }),
    ...(epoch !== undefined && { log: { epoch, seq: Number(seq) } }),
  };
}

/** One event of a session's stream and the cursor right after it. */
export interface StreamItem {
  readonly cursor: Cursor;
  readonly event: AgentWireEvent;
}

export const streamItemSchema = z.object({
  cursor: cursorSchema,
  event: agentWireEventSchema,
});
