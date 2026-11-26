import * as z from "zod";

import { cursorSchema } from "./cursor.ts";
import { agentWireEventSchema } from "./events.ts";

export const sessionIdSchema = z.string().min(1).max(64);

const sessionInfoSchema = z.object({ id: z.string(), createdAt: z.number() });
const decisionSchema = z.object({
  toolCallId: z.string(),
  approved: z.boolean(),
  comment: z.string().optional(),
});
const outcomeSchema = z.object({ toolCallId: z.string(), outcome: z.enum(["applied", "already_decided"]) });

/**
 * Where a deferred call's reply goes: the asking instance's `scope`, the session, the call, and a token that only the
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
 * A map of calls whose entry for a method `M` parses to `M`'s own types, even where `M` is a type parameter. Indexing
 * the plain map by a generic method gives the union of every method's schema instead.
 */
export type CallSchemaMap<T extends Record<string, CallSchema>> = {
  readonly [M in keyof T]: T[M] & {
    readonly params: z.ZodType<z.output<T[M]["params"]>, z.input<T[M]["params"]>>;
    readonly result: z.ZodType<z.output<T[M]["result"]>, z.input<T[M]["result"]>>;
  };
};

const schemas = {
  /**
   * A session with the agent's model, tools and approval policy. The app chooses what a session runs with. Its
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
       * While a run is going, `queue`, the default, starts a run once it has answered, `steer` joins it after its
       * current tool round, and `reject` refuses it with `session_busy`. Between `wrapup:start` and `wrapup:end`, a run
       * has answered and its wrap-up goes on, so `reject` refuses the input and every other input waits. With neither
       * going on, each starts a run.
       */
      whenBusy: z.enum(["queue", "steer", "reject"]).optional(),
      /** Makes the input an ask. The run's answer goes to this address once the run ends. An ask always queues. */
      replyTo: replyAddressSchema.optional(),
    }),
    result: z.object({ submissionId: z.string() }),
    writes: true,
  },
  /**
   * A run on the session's context as it is, without a new message. It carries on a run that ended without an answer,
   * such as one at its turn limit. It runs only while no run is going, and is refused with `session_busy` otherwise.
   * Its `requestId`, like `submit`'s, makes a retry return the first continue.
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
   * A reply to a deferred call parked in the session, which may be a child session, with the token of its reply
   * address. A second reply to the same call is `already_replied`, so a delivery may be retried.
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
   * summary should keep. The thread keeps the messages. The call is answered once the compaction is admitted, and the
   * stream shows the compaction go through `compaction:start`, `session:compacted` and `compaction:end`.
   */
  compact: {
    params: z.object({ sessionId: sessionIdSchema, instructions: z.string().optional() }),
    result: z.null(),
    writes: true,
  },
  /**
   * Takes back an input still waiting for a run, by the `submissionId` its `submit` gave. The outcome is `withdrawn`,
   * `already_placed` when a run took it first, or `settled` when it was answered or dropped already. An ask's input
   * cannot be withdrawn, because its asker waits for its answer, and the call fails with `invalid_request`.
   */
  withdraw: {
    params: z.object({ sessionId: sessionIdSchema, submissionId: z.string().min(1) }),
    result: z.object({ outcome: z.enum(["withdrawn", "already_placed", "settled"]) }),
    writes: true,
  },
  deleteSession: { params: z.object({ sessionId: sessionIdSchema }), result: z.null(), writes: true },
} satisfies Record<string, CallSchema>;

/**
 * Every call an instance answers, with what it takes, what it answers, and whether it changes the instance's sessions,
 * in `writes`. A readonly caller may make only the calls that do not.
 */
export const callSchemas: CallSchemaMap<typeof schemas> = schemas;

export type CallMethod = keyof typeof schemas;
/** What a call of `M` takes, as its sender writes it. */
export type CallParams<M extends CallMethod> = z.input<(typeof schemas)[M]["params"]>;
/** What a call of `M` answers, as its receiver reads it. */
export type CallResult<M extends CallMethod> = z.output<(typeof schemas)[M]["result"]>;
/** A call as the instance's side runs it, its params parsed. `Call<M>` is a call of `M`, or of any method in `M`. */
export type Call<M extends CallMethod = CallMethod> = {
  readonly [K in M]: { readonly method: K; readonly params: z.output<(typeof schemas)[K]["params"]> };
}[M];

/** The errors a call is answered with. `internal` carries no detail, because the server reports it. */
export const callErrorCodeSchema = z.enum([
  /**
   * A call that does not parse: an unknown method, a missing field, a cursor of another session, or a `withdraw` of an
   * input the session does not hold or of an ask's.
   */
  "invalid_request",
  "session_not_found",
  /** `submit` with `whenBusy: "reject"`, or `continue`, while a run is going or wraps up after `wrapup:start`. */
  "session_busy",
  /**
   * `submit`, `continue`, `withdraw`, `compact` or `deleteSession` of a child session. Only its delegate submits to it,
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

/** The server stopped following a session for the client, because the session was deleted or cannot be read. */
export const followEndedSchema = z.object({ sessionId: sessionIdSchema, error: callErrorSchema });
