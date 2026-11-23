import * as z from "zod";

/**
 * The client contract: one domain-free event vocabulary for an agent session. Nothing here depends on
 * pi, a provider SDK or Node, so a browser bundle can import it. Events are derived on the server
 * from committed conversation state; live events and replayed history fold through the same
 * `applyEvent` reducer (`./view.ts`).
 */

export const deltaChannelSchema = z.enum(["text", "thinking"]);
export type DeltaChannel = z.infer<typeof deltaChannelSchema>;

/** A reply's token counts as its provider reported them; `cost` is in the provider's currency units. */
export const usageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  cost: z.number().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

/** How a tool call ended. `aborted`: it never produced a result (stopped, or cut off by a restart). */
export const toolEndStatusSchema = z.enum(["ok", "error", "aborted"]);
export type ToolEndStatus = z.infer<typeof toolEndStatusSchema>;

/** The `tier` of a call whose tier is not known: the agent has no such tool, or its start has not come yet. */
export const UNKNOWN_TIER = "unknown";

/**
 * How a run ended. `interrupted`: the process stopped it and it could not be carried on (pi's
 * `interrupted` and `restart_limit`), or a replayed transcript stops short without saying why.
 */
export const runEndReasonSchema = z.enum(["done", "aborted", "error", "interrupted"]);
export type RunEndReason = z.infer<typeof runEndReasonSchema>;

/**
 * What started a compaction: `manual` (the app asked for it), `threshold` (the context neared the model's window) or
 * `overflow` (a request overflowed it).
 */
export const compactionReasonSchema = z.enum(["manual", "threshold", "overflow"]);
export type CompactionReason = z.infer<typeof compactionReasonSchema>;

/**
 * An input waiting for a run: `steer` (submitted with `whenBusy: "steer"`) joins the run going on after its current
 * tool round, `queue` starts a run once the run going on has answered.
 */
export const queuedInputSchema = z.object({
  /** The `submissionId` its `submit` gave, which `withdraw` takes. */
  submissionId: z.string(),
  text: z.string(),
  whenBusy: z.enum(["queue", "steer"]),
});
export type QueuedInput = z.infer<typeof queuedInputSchema>;

export const agentWireEventSchema = z.discriminatedUnion("type", [
  /** A run started: the agent is working on an input, or carrying on a run that ended unanswered (`continue`). */
  z.object({ type: z.literal("run:start") }),
  z.object({
    type: z.literal("user"),
    /** The persisted entry id, live and replayed alike. */
    messageId: z.string(),
    text: z.string(),
    /** Epoch ms. */
    at: z.number().optional(),
    /** The input joined the run going on, after one of its tool rounds, instead of starting a run. */
    steer: z.literal(true).optional(),
  }),
  /** A reply began streaming. Its id is a stream id; the reply's `assistant:end` names its entry. */
  z.object({ type: z.literal("assistant:start"), messageId: z.string() }),
  z.object({
    type: z.literal("assistant:delta"),
    messageId: z.string(),
    channel: deltaChannelSchema,
    delta: z.string(),
  }),
  /**
   * A reply as stored: whole, replacing the reply that streamed for it. `messageId` is the persisted
   * entry id. A failed or cut-off reply ends too, with its `stopReason`.
   */
  z.object({
    type: z.literal("assistant:end"),
    messageId: z.string(),
    text: z.string(),
    thinking: z.string().optional(),
    stopReason: z.string(),
    /** The provider's message for a reply that failed. */
    error: z.string().optional(),
    usage: usageSchema.optional(),
    at: z.number().optional(),
  }),
  /** The streaming reply began a tool call whose arguments the model is still writing. */
  z.object({
    type: z.literal("tool:draft"),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
  /** The model called a tool; emitted from the stored reply, so replay and live agree. */
  z.object({
    type: z.literal("tool:start"),
    toolCallId: z.string(),
    toolName: z.string(),
    label: z.string(),
    tier: z.string(),
    args: z.unknown(),
  }),
  /** Progress a running call published: its retained output and its latest details. */
  z.object({
    type: z.literal("tool:update"),
    toolCallId: z.string(),
    output: z.string().optional(),
    details: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool:end"),
    toolCallId: z.string(),
    toolName: z.string(),
    status: toolEndStatusSchema,
    /** What the model read, for a call that failed (clipped). */
    error: z.string().optional(),
    /** The tool's own view model for clients. */
    details: z.unknown().optional(),
  }),
  /** A call waits for an operator's decision before it runs. */
  z.object({
    type: z.literal("approval:request"),
    toolCallId: z.string(),
    toolName: z.string(),
    tier: z.string(),
    args: z.unknown(),
  }),
  /** The decision; a declined call then ends with its comment as the result the model read. */
  z.object({
    type: z.literal("approval:resolved"),
    toolCallId: z.string(),
    approved: z.boolean(),
    comment: z.string().optional(),
  }),
  /**
   * A deferred call started its work elsewhere and is parked until a reply reaches it, or until its deadline passes.
   * Its `tool:end` follows either way.
   */
  z.object({
    type: z.literal("reply:wait"),
    toolCallId: z.string(),
    /** Epoch ms of the deadline: a reply after it is refused, and the call ends with an error result. */
    until: z.number().optional(),
  }),
  /** A model request failed and waits to be sent again. */
  z.object({
    type: z.literal("retry:wait"),
    error: z.string(),
    /** Epoch ms of the next attempt. */
    at: z.number(),
  }),
  /** The wait is over: the request was sent again, or its run ended. */
  z.object({ type: z.literal("retry:end") }),
  /** A compaction is going on: older messages are being summarized. `session:compacted` follows once it succeeds. */
  z.object({ type: z.literal("compaction:start"), reason: compactionReasonSchema }),
  /**
   * No compaction is going on any more. `error`: the newest one failed, and the model reads the messages as they were;
   * a client may show it until a later compaction succeeds.
   */
  z.object({ type: z.literal("compaction:end"), error: z.string().optional() }),
  /** A summary took the place of older messages in what the model reads; the thread keeps them. */
  z.object({
    type: z.literal("session:compacted"),
    messageId: z.string(),
    summary: z.string(),
    at: z.number().optional(),
  }),
  /**
   * The inputs waiting for a run, in the order they were submitted: all of them, whenever the queue changes. An input
   * leaves it when a run takes it (its `user` event follows), or when it is withdrawn, or dropped with an aborted run.
   */
  z.object({ type: z.literal("queue"), items: z.array(queuedInputSchema) }),
  z.object({
    type: z.literal("run:end"),
    reason: runEndReasonSchema,
    /**
     * The engine's code for a run that did not finish, such as `model_error`, `no_model`, or `no_credentials` (the
     * model request found no credential for its provider).
     */
    code: z.string().optional(),
    /** A message for the operator, when the engine gave one. */
    error: z.string().optional(),
  }),
  /**
   * Transport-level: the cursor a client resumed from cannot be honoured (it names an entry this
   * session's storage does not hold, as after a restore from an older backup). Discard the folded
   * view; a full replay follows.
   */
  z.object({ type: z.literal("stream:reset") }),
]);

export type AgentWireEvent = z.infer<typeof agentWireEventSchema>;
export type AgentWireEventType = AgentWireEvent["type"];
export type AgentWireEventOf<T extends AgentWireEventType> = Extract<AgentWireEvent, { type: T }>;
