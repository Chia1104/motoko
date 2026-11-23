import type { JsonValue } from "@earendil-works/chord/json";
import type { ToolExecutionMode, ToolRegistration } from "@earendil-works/pi-durable";
import * as z from "zod";

import type { ReplyAddress } from "@chia1104/motoko-wire";

import type { AgentDefinition } from "./agent.ts";
import type { StorageScope } from "./host.ts";
import { toolJsonSchema } from "./json-schema.ts";
import type { ToolJsonSchema } from "./json-schema.ts";

/** Where one tool call runs: what the runtime's `portsFor` resolves the call's ports from. */
export interface PortsTarget {
  /** The agent instance: with one instance per caller, the caller. */
  readonly scope: StorageScope;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** Aborts when the call is stopped: the session is aborted or the instance closes. */
  readonly signal: AbortSignal;
}

/**
 * Resolves the ports of one tool call, right before it executes: after its approval, if it needed
 * one, and again for a call a restart reruns. It may be async. A throw or rejection fails that call
 * alone, with a `PortsUnavailableError` the model reads, and is reported as `ports_failed`.
 */
export type PortsResolver<Ports> = (target: PortsTarget) => Ports | Promise<Ports>;

/** What one call's `execute` gets besides its arguments. */
export interface ToolContext<Ports = unknown> {
  /** The app's ports: the runtime's `ports`, or what its `portsFor` resolved for this call. */
  readonly ports: Ports;
  /** Aborts when the call is stopped: the session is aborted or the instance closes. */
  readonly signal: AbortSignal;
  /** The agent instance the call runs in. */
  readonly scope: StorageScope;
  readonly sessionId: string;
  /** The model's id for the call; stable across a replay after a restart. */
  readonly toolCallId: string;
  /**
   * Appends running output that clients see as `tool:update` while the call runs. Progress is
   * committed at most every 100 ms and may be lost in a crash; the result is what the model reads.
   */
  output(text: string): void;
  /** Replaces the running details clients see as `tool:update`; the result's `details` win at the end. */
  update(details: JsonValue): Promise<void>;
}

/** What a call produced: `text` is what the model reads, `details` what clients render. */
export interface ToolResult<Details extends JsonValue = JsonValue> {
  readonly text: string;
  readonly details?: Details;
}

export interface ToolSpec<Ports, Params extends z.ZodType, Details extends JsonValue> {
  readonly name: string;
  readonly description: string;
  /** For clients; defaults to `name`. */
  readonly label?: string;
  /** The agent's policy decides from the tier whether a call needs approval. */
  readonly tier: string;
  /**
   * Whether a call a crash or close cut off may run again when the instance reopens: pi-durable's
   * `replay`, passed through. `unsafe` (default): the model is told the call was interrupted.
   * Declare `safe` only for a tool whose second run cannot duplicate an effect.
   */
  readonly replay?: ToolRegistration["replay"];
  /** pi-durable's `executionMode`: `sequential` runs the call alone, after the round's earlier calls. */
  readonly executionMode?: ToolExecutionMode;
  readonly parameters: Params;
  /**
   * Gets the arguments parsed with `parameters`. Throwing hands the model an error result with the
   * message. A method, so a tool typed for its own ports still fits an agent's wider ones.
   */
  execute(args: z.output<Params>, context: ToolContext<Ports>): Promise<ToolResult<Details>>;
}

/** An app's tool: what `defineTool` returns, run by its own `execute`. */
export interface AppToolDefinition<
  // oxlint-disable-next-line typescript/no-explicit-any -- ports appear only in parameter positions
  Ports = any,
  Params extends z.ZodType = z.ZodType,
  Details extends JsonValue = JsonValue,
> extends ToolSpec<Ports, Params, Details> {
  readonly kind: "app";
  readonly label: string;
  readonly replay: NonNullable<ToolRegistration["replay"]>;
  /** The JSON Schema pi-durable validates against, computed once. */
  readonly jsonSchema: ToolJsonSchema;
}

export interface DelegateSpec<Ports> {
  readonly name: string;
  /** What the model reads to decide when to hand a task to the sub-agent. */
  readonly description: string;
  /** For clients; defaults to `name`. */
  readonly label?: string;
  /** The agent's policy decides from the tier whether a call needs approval, as for any tool. */
  readonly tier: string;
  readonly executionMode?: ToolExecutionMode;
  /** The sub-agent the call runs in a child session. */
  readonly agent: AgentDefinition<Ports>;
}

/** The parameters every delegate takes: the task, which is all the sub-agent sees of its caller. */
const delegateParameters = z.object({
  task: z.string().describe("The task, complete in itself: the sub-agent sees nothing else of this conversation."),
});

/** A delegate: its call runs its sub-agent in a child session and returns the sub-agent's answer. */
// oxlint-disable-next-line typescript/no-explicit-any -- see `AppToolDefinition`
export interface DelegateDefinition<Ports = any> {
  readonly kind: "delegate";
  readonly name: string;
  readonly description: string;
  readonly label: string;
  readonly tier: string;
  readonly executionMode?: ToolExecutionMode;
  /** A rerun after a crash finds the child and the submission the first run made. */
  readonly replay: "safe";
  readonly parameters: typeof delegateParameters;
  readonly jsonSchema: ToolJsonSchema;
  readonly agent: AgentDefinition<Ports>;
}

/** What a deferred call's `start` and `cancel` get besides its arguments. */
export interface DeferredContext<Ports = unknown> {
  /** The app's ports: the runtime's `ports`, or what its `portsFor` resolved for this call. */
  readonly ports: Ports;
  /** Aborts when this run of the call is stopped: the session is aborted or the instance closes. */
  readonly signal: AbortSignal;
  /** The agent instance the call runs in. */
  readonly scope: StorageScope;
  readonly sessionId: string;
  readonly toolCallId: string;
  /**
   * The call's idempotency key for the work it starts, the same in every run of `start` and unique across instances:
   * `start` may run again after a crash, so the work it starts must be idempotent by it, as `submit` is by `requestId`.
   */
  readonly requestId: string;
  /** Where the work's answer goes: an ask hands it to the asked instance as `submit`'s `replyTo`. */
  readonly replyTo: ReplyAddress;
}

export interface DeferredSpec<Ports, Params extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  /** For clients; defaults to `name`. */
  readonly label?: string;
  /** The agent's policy decides from the tier whether a call needs approval, as for any tool. */
  readonly tier: string;
  readonly executionMode?: ToolExecutionMode;
  readonly parameters: Params;
  /** How long a call waits for its reply, in ms, before it ends with an error result. Default: 24 hours. */
  readonly timeoutMs?: number;
  /**
   * Starts the work elsewhere and hands it `context.replyTo`; the call then parks until a reply reaches that address.
   * It runs once the call passed its gate, and may run again after a crash before the park. A throw ends the call
   * with an error result the model reads. A method, so a tool typed for its own ports still fits an agent's wider ones.
   */
  start(args: z.output<Params>, context: DeferredContext<Ports>): Promise<void>;
  /** Runs when the call is stopped while it waits, so the work it started may stop too. It may run more than once. */
  cancel?(args: z.output<Params>, context: DeferredContext<Ports>): Promise<void>;
}

/** A deferred tool: its call starts work elsewhere and returns the reply that work sends back. */
export interface DeferredDefinition<
  // oxlint-disable-next-line typescript/no-explicit-any -- see `AppToolDefinition`
  Ports = any,
  Params extends z.ZodType = z.ZodType,
> extends DeferredSpec<Ports, Params> {
  readonly kind: "deferred";
  readonly label: string;
  /** A rerun after a crash starts the same work again, by the same `requestId`. */
  readonly replay: "safe";
  readonly timeoutMs: number;
  readonly jsonSchema: ToolJsonSchema;
}

/** A tool of an agent, by `kind`: an app's tool, a delegate, or a deferred tool, the last two run by the runtime. */
export type ToolDefinition<
  // oxlint-disable-next-line typescript/no-explicit-any -- see `AppToolDefinition`
  Ports = any,
  Params extends z.ZodType = z.ZodType,
  Details extends JsonValue = JsonValue,
> = AppToolDefinition<Ports, Params, Details> | DelegateDefinition<Ports> | DeferredDefinition<Ports, Params>;

const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function checkTool(spec: { readonly name: string; readonly tier: string }) {
  if (!TOOL_NAME.test(spec.name)) {
    throw new TypeError(`Tool name \`${spec.name}\` must match ${TOOL_NAME}`);
  }
  if (spec.tier.length === 0) throw new TypeError(`Tool \`${spec.name}\` needs a tier`);
}

/**
 * Declares a tool. The definition holds no ports: it is importable by a client or a capability
 * listing, and the runtime binds it to pi-durable with the instance's ports when it runs.
 */
export function defineTool<
  Ports = unknown,
  Params extends z.ZodType = z.ZodType,
  Details extends JsonValue = JsonValue,
>(spec: ToolSpec<Ports, Params, Details>): AppToolDefinition<Ports, Params, Details> {
  checkTool(spec);
  return Object.freeze({
    ...spec,
    kind: "app",
    label: spec.label ?? spec.name,
    replay: spec.replay ?? "unsafe",
    jsonSchema: toolJsonSchema(spec.name, spec.parameters),
  });
}

const delegateJsonSchema = toolJsonSchema("delegate", delegateParameters);

/**
 * Declares a delegate: a tool whose call runs `agent` in a child session of the caller's, with the task the model
 * writes, and returns its answer. The sub-agent's definition is complete before the delegate is, so delegates never
 * loop.
 */
export function defineDelegate<Ports = unknown>(spec: DelegateSpec<Ports>): DelegateDefinition<Ports> {
  checkTool(spec);
  return Object.freeze({
    kind: "delegate",
    name: spec.name,
    description: spec.description,
    label: spec.label ?? spec.name,
    tier: spec.tier,
    ...(spec.executionMode !== undefined && { executionMode: spec.executionMode }),
    replay: "safe",
    parameters: delegateParameters,
    jsonSchema: delegateJsonSchema,
    agent: spec.agent,
  });
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Declares a deferred tool: a tool whose call runs `start`, which starts work elsewhere with a reply address, and then
 * parks, holding no process, until a reply reaches that address or `timeoutMs` passes. Its result is the reply.
 */
export function defineDeferredTool<Ports = unknown, Params extends z.ZodType = z.ZodType>(
  spec: DeferredSpec<Ports, Params>,
): DeferredDefinition<Ports, Params> {
  checkTool(spec);
  const timeoutMs = spec.timeoutMs ?? DAY;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new TypeError(`Tool \`${spec.name}\`'s \`timeoutMs\` must be a positive number of milliseconds`);
  }
  return Object.freeze({
    ...spec,
    kind: "deferred",
    label: spec.label ?? spec.name,
    replay: "safe",
    timeoutMs,
    jsonSchema: toolJsonSchema(spec.name, spec.parameters),
  });
}
