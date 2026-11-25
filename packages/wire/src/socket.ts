import * as z from "zod";

import { callErrorCodeSchema, callSchemas, followedEventSchema, followEndedSchema, sessionIdSchema } from "./call.ts";
import type { CallSchema } from "./call.ts";
import { cursorSchema } from "./cursor.ts";

const callId = z.string().min(1).max(64);

/**
 * Every call on the socket. These are the instance's calls in `callSchemas`, and the two that exist because one socket
 * follows several sessions. Over HTTP, following a session is a request of its own instead.
 */
export const motokoCalls = {
  /**
   * Follow a session's events on this connection from `from`, or from its start by default, replacing an earlier
   * follow of it.
   * The result comes before the first event, so a client folds nothing of this follow before it.
   */
  subscribe: {
    params: z.object({ sessionId: sessionIdSchema, from: cursorSchema.optional() }),
    result: z.null(),
    writes: false,
  },
  unsubscribe: { params: z.object({ sessionId: sessionIdSchema }), result: z.null(), writes: false },
  ...callSchemas,
} satisfies Record<string, CallSchema>;

export type MotokoMethod = keyof typeof motokoCalls;
/** What a call of `M` takes, as its sender writes it. */
export type MotokoParams<M extends MotokoMethod> = z.input<(typeof motokoCalls)[M]["params"]>;
/** What a call of `M` answers, as its receiver reads it. */
export type MotokoResult<M extends MotokoMethod> = z.output<(typeof motokoCalls)[M]["result"]>;
/** A call as the server runs it, with its params parsed. `authorize` decides on it. */
export type MotokoCall = {
  readonly [M in MotokoMethod]: { readonly method: M; readonly params: z.output<(typeof motokoCalls)[M]["params"]> };
}[MotokoMethod];

const METHODS = Object.keys(motokoCalls) as [MotokoMethod, ...MotokoMethod[]];

/** Client to server. The server checks `params` against its method's schema in a second step, so bad params still get an error for the frame's id. */
export const callFrameSchema = z.object({
  type: z.literal("motoko:call"),
  id: callId,
  method: z.enum(METHODS),
  params: z.unknown(),
});
export type CallFrame = z.output<typeof callFrameSchema>;

/**
 * The errors the server answers with, the call protocol's and the socket's own. `internal` carries no detail, because
 * the object reports it as a `motoko:socket_error`.
 */
export const motokoErrorCodeSchema = z.enum([
  ...callErrorCodeSchema.options,
  /** The connection follows as many sessions as it may. */
  "too_many_subscriptions",
]);
export type MotokoErrorCode = z.output<typeof motokoErrorCodeSchema>;

const errorSchema = z.object({ code: motokoErrorCodeSchema, message: z.string() });
export type MotokoErrorBody = z.output<typeof errorSchema>;

/** Server to client. */
export const serverFrameSchema = z.discriminatedUnion("type", [
  followedEventSchema.extend({ type: z.literal("motoko:event") }),
  z.object({ type: z.literal("motoko:result"), id: callId, result: z.unknown() }),
  z.object({ type: z.literal("motoko:error"), id: callId, error: errorSchema }),
  followEndedSchema.extend({ type: z.literal("motoko:ended") }),
]);
export type ServerFrame = z.input<typeof serverFrameSchema>;

/** A text frame of Motoko's, as JSON; `undefined` for any other message, which is the SDK's or the app's. */
export function motokoFrame(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { type } = value as { type?: unknown };
  return typeof type === "string" && type.startsWith("motoko:") ? (value as Record<string, unknown>) : undefined;
}
