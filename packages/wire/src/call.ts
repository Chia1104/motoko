import * as z from "zod";

import { cursorSchema } from "./cursor.ts";
import { agentWireEventSchema } from "./events.ts";

/**
 * The call protocol: what a client asks of one instance, what it answers, and the errors it answers with, whatever
 * the transport. A transport frames these in its own envelope (a socket's `motoko:` frames, an HTTP request) and adds
 * what only it has, such as following several sessions on one connection.
 */

export const sessionIdSchema = z.string().min(1).max(64);

const sessionInfoSchema = z.object({ id: z.string(), createdAt: z.number() });
const decisionSchema = z.object({
  toolCallId: z.string(),
  approved: z.boolean(),
  comment: z.string().optional(),
});
const outcomeSchema = z.object({ toolCallId: z.string(), outcome: z.enum(["applied", "already_decided"]) });

/**
 * Where a deferred call's reply goes: the asking instance (`scope`), the session and the call, and a token that only the
 * work the call started knows. It travels as `submit`'s `replyTo` and comes back as `reply`'s params.
 */
export const replyAddressSchema = z.object({
  scope: z.object({ kind: z.string().min(1), name: z.string().min(1) }),
  sessionId: sessionIdSchema,
  toolCallId: z.string().min(1),
  token: z.string().min(1),
});
export type ReplyAddress = z.output<typeof replyAddressSchema>;

/** One call's schemas, as a transport that adds calls of its own writes them. */
export interface CallSchema {
  readonly params: z.ZodType;
  readonly result: z.ZodType;
  readonly writes: boolean;
}

/**
 * Every call an instance answers: what it takes, what it answers, and whether it changes the instance's sessions
 * (`writes`). A readonly caller may make only the calls that do not.
 */
export const callSchemas = {
  /**
   * A session with the agent's model, tools and approval policy: what a session runs with is the app's to choose. Its
   * `requestId`, like `submit`'s, makes a retry return the session the first call made.
   */
  createSession: {
    params: z.object({ requestId: z.string().min(1).optional() }),
    result: sessionInfoSchema,
    writes: true,
  },
  listSessions: { params: z.object({}), result: z.array(sessionInfoSchema), writes: false },
  submit: {
    params: z.object({
      sessionId: sessionIdSchema,
      text: z.string(),
      requestId: z.string().min(1),
      /**
       * While a run is going: `queue` (default) starts a run once it has answered, `steer` joins it after its current
       * tool round, `reject` refuses it (`session_busy`). Between `wrapup:start` and `wrapup:end` a run answered and its
       * wrap-up goes on: `reject` refuses the input, and every other input waits. With neither, each starts a run.
       */
      whenBusy: z.enum(["queue", "steer", "reject"]).optional(),
      /** Makes it an ask: the run's answer goes to this address once the run ends. An ask always queues. */
      replyTo: replyAddressSchema.optional(),
    }),
    result: z.object({ submissionId: z.string() }),
    writes: true,
  },
  /**
   * A run on the session's context as it is, without a new message: it carries on a run that ended without an answer,
   * such as one at its turn limit. Only while no run is going (`session_busy`). Its `requestId`, like `submit`'s, makes
   * a retry return the first continue.
   */
  continue: {
    params: z.object({ sessionId: sessionIdSchema, requestId: z.string().min(1) }),
    result: z.object({ submissionId: z.string() }),
    writes: true,
  },
  approve: {
    params: z.object({ sessionId: sessionIdSchema, decisions: z.array(decisionSchema).min(1) }),
    result: z.array(outcomeSchema),
    writes: true,
  },
  /**
   * A reply to a deferred call parked in the session (a child session too), with the token of its reply address. A
   * second reply to the same call is `already_replied`, so a delivery may be retried.
   */
  reply: {
    params: z.object({
      sessionId: sessionIdSchema,
      toolCallId: z.string().min(1),
      token: z.string().min(1),
      text: z.string(),
      isError: z.boolean().optional(),
    }),
    result: z.object({ outcome: z.enum(["applied", "already_replied"]) }),
    writes: true,
  },
  abort: { params: z.object({ sessionId: sessionIdSchema }), result: z.null(), writes: true },
  /**
   * Summarizes the session's older messages into what the model reads from then on, with `instructions` for what the
   * summary should keep; the thread keeps the messages. Answered once the compaction is admitted: the stream shows it
   * go (`compaction:start`, `session:compacted`, `compaction:end`).
   */
  compact: {
    params: z.object({ sessionId: sessionIdSchema, instructions: z.string().optional() }),
    result: z.null(),
    writes: true,
  },
  /**
   * Takes back an input still waiting for a run, by the `submissionId` its `submit` gave: `withdrawn`, or
   * `already_placed` when a run took it first, or `settled` when it was answered or dropped already. An ask's input
   * cannot be withdrawn: its asker waits for its answer (`invalid_request`).
   */
  withdraw: {
    params: z.object({ sessionId: sessionIdSchema, submissionId: z.string().min(1) }),
    result: z.object({ outcome: z.enum(["withdrawn", "already_placed", "settled"]) }),
    writes: true,
  },
  deleteSession: { params: z.object({ sessionId: sessionIdSchema }), result: z.null(), writes: true },
} satisfies Record<string, CallSchema>;

export type CallMethod = keyof typeof callSchemas;
/** What a call of `M` takes, as its sender writes it. */
export type CallParams<M extends CallMethod> = z.input<(typeof callSchemas)[M]["params"]>;
/** What a call of `M` answers, as its receiver reads it. */
export type CallResult<M extends CallMethod> = z.output<(typeof callSchemas)[M]["result"]>;
/** A call as the instance's side runs it, its params parsed. */
export type Call = {
  readonly [M in CallMethod]: { readonly method: M; readonly params: z.output<(typeof callSchemas)[M]["params"]> };
}[CallMethod];

/** The errors a call is answered with. `internal` carries no detail: the server reports it. */
export const callErrorCodeSchema = z.enum([
  /**
   * A call that does not parse: an unknown method, a missing field, a cursor of another session, or a `withdraw` of an
   * input the session does not hold or of an ask's.
   */
  "invalid_request",
  "session_not_found",
  /** `submit` with `whenBusy: "reject"`, or `continue`, while a run is going or wraps up (`wrapup:start`). */
  "session_busy",
  /**
   * `submit`, `continue`, `withdraw`, `compact` or `deleteSession` of a child session: only its delegate submits to it,
   * and it goes with its parent.
   */
  "session_owned",
  /** A decision for a call that is not waiting for one; no decision of the batch was applied. */
  "approval_not_pending",
  /** A reply to a call that is not waiting for one, or with a token that is not the call's. */
  "reply_not_pending",
  "invalid_cursor",
  /** The instance lost its lease or its storage failed. */
  "instance_closed",
  /** Another writer holds the instance. */
  "lease_held",
  /** A readonly caller's call that writes, or a call the app's `authorize` refused; nothing of it ran. */
  "forbidden",
  "internal",
]);
export type CallErrorCode = z.output<typeof callErrorCodeSchema>;

/** A call's error as it travels: its code, which a client branches on, and a message for people. */
export const callErrorSchema = z.object({ code: callErrorCodeSchema, message: z.string() });
export type CallError = z.output<typeof callErrorSchema>;

/** One event of a session the client follows, with the cursor right after it. */
export const followedEventSchema = z.object({
  sessionId: sessionIdSchema,
  cursor: cursorSchema,
  event: agentWireEventSchema,
});

/** The server stopped following a session for the client: it was deleted, or it cannot be read. */
export const followEndedSchema = z.object({ sessionId: sessionIdSchema, error: callErrorSchema });
