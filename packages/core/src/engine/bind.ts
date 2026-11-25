import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  section,
  SubmissionSettled,
} from "@earendil-works/pi-durable";
import type { EntryId, Extension, SignalState, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import * as z from "zod";

import type { AgentDefinition } from "../agent.ts";
import { PortsUnavailableError } from "../errors.ts";
import { scopeKey } from "../host.ts";
import type { StorageScope } from "../host.ts";
import { omitOfferedNulls } from "../json-schema.ts";
import type {
  AppToolDefinition,
  DeferredContext,
  DeferredDefinition,
  DelegateDefinition,
  PortsTarget,
} from "../tool.ts";

import { answerOf } from "./answers.ts";
import type { Settled } from "./answers.ts";
import { approvalGate } from "./approvals.ts";
import { CallsDoc, startedCall } from "./calls.ts";
import type { AppExtensions } from "./extensions.ts";
import { newToken, REPLY_KEY, ReplySignal } from "./replies.ts";
import { SessionsDoc } from "./sessions.ts";

const NEVER = new AbortController().signal;

/** The extension name an agent's tools, prompt and gate are installed under. */
export const extensionName = (agent: AgentDefinition) => `runtime:${agent.kind}`;

interface BindOptions {
  readonly scope: StorageScope;
  /** The ports of one call, resolved where it runs, right before it executes. */
  readonly ports: (target: PortsTarget) => unknown;
  /** The ports of a call could not be resolved; the call fails with a `PortsUnavailableError`. */
  readonly portsFailed: (target: PortsTarget, error: unknown) => void;
  /** The app's extensions this open installs: what each agent's sessions select with its own, and their tools. */
  readonly app: AppExtensions;
  /** How long a nested call waits at the gate for a decision, in ms, before it fails for the tool that made it. */
  readonly nestedApprovalTimeoutMs: number;
}

/**
 * A runtime tool as pi-durable runs it: JSON Schema validation, then the zod parse, then the call's
 * ports, then `execute`.
 */
function toPiTool(tool: AppToolDefinition, { scope, ports: portsOf, portsFailed }: BindOptions): ToolRegistration {
  const { schema, offered } = tool.jsonSchema;
  return defineTool({
    name: tool.name,
    description: tool.description,
    // Plain JSON Schema: pi validates and coerces against it as written.
    parameters: offered,
    replay: tool.replay,
    ...(tool.executionMode !== undefined && { executionMode: tool.executionMode }),
    prepareArguments: (args: unknown) => omitOfferedNulls(schema, args) as Record<string, unknown>,
    async execute(args, api, context: Context) {
      const parsed = tool.parameters.safeParse(args);
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
      const signal = context.abortSignal ?? NEVER;
      const target: PortsTarget = {
        scope,
        sessionId: String(api.conversationId),
        toolCallId: api.callId,
        toolName: tool.name,
        signal,
      };
      let ports: unknown;
      try {
        ports = await portsOf(target);
      } catch (error) {
        // The call fails before it runs, so it had no effect; the model reads why, the app the cause.
        portsFailed(target, error);
        throw new PortsUnavailableError(tool.name, error);
      }
      const result = await tool.execute(parsed.data, {
        ports,
        signal,
        scope,
        sessionId: target.sessionId,
        toolCallId: api.callId,
        output: (text) => api.output(text),
        update: (details) => api.details(details, context),
      });
      return {
        output: [{ type: "text", text: result.text }],
        ...(result.details !== undefined && { details: result.details }),
      };
    },
  });
}

/** The key a delegate's call parks on: one wait per call, for its child's one submission. */
const ANSWERED = "answered";

const text = (value: string) => [{ type: "text" as const, text: value }];

/** The call's result once its child's submission settled: the sub-agent's answer, or why there is none. */
async function delegateResult(
  settled: SignalState<Settled>,
  api: ToolExecutionApi,
  agent: AgentDefinition,
  context: Context,
) {
  if ("expired" in settled) return { output: text("The sub-agent never answered."), isError: true };
  const record = settled.value;
  const details = { sessionId: String(record.conversationId), agent: agent.kind };
  const read = (id: EntryId) => api.commit((tx) => tx.entry(AssistantEntry, id), context);
  const answer = await answerOf(record, read, "The sub-agent");
  return { output: text(answer.text), ...(answer.isError && { isError: true }), details };
}

/**
 * A delegate as pi-durable runs it: a replay-safe tool that parks. Its first run makes the child session (its
 * conversation, owned by the call's task, and its records, in one commit), submits the task to it with a request ID
 * of the call's, and parks until that submission settles. A rerun after a crash at any point finds the same child and
 * the same submission. Woken, it returns the child's answer.
 */
function toDelegate(
  tool: DelegateDefinition,
  extensions: ReadonlyMap<string, Extension>,
  app: AppExtensions,
): ToolRegistration {
  const { schema, offered } = tool.jsonSchema;
  const { agent } = tool;
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: offered,
    replay: "safe",
    ...(tool.executionMode !== undefined && { executionMode: tool.executionMode }),
    prepareArguments: (args: unknown) => omitOfferedNulls(schema, args) as Record<string, unknown>,
    async execute(args, api, context: Context) {
      const parsed = tool.parameters.safeParse(args);
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
      const settled = await api.readSignal(SubmissionSettled, ANSWERED, context);
      if (settled !== undefined) return delegateResult(settled, api, agent, context);
      const childId = await api.commit(async (tx) => {
        // Table reads come before the commit's first write.
        const owned = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (owned !== undefined) return owned.id;
        const sessions = await tx.doc(SessionsDoc);
        const calls = await tx.doc(CallsDoc, api.conversationId);
        const { id } = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        // The child starts as a copy of its parent's agent: it takes the sub-agent's extension, after the app's that
        // select the sub-agent, all of its tools, and its model when it names one.
        await configure(tx, id, {
          // SAFETY: the instance installs an extension for every agent its delegates reach.
          extensions: app.selectionOf(agent.kind, extensions.get(agent.kind)!),
          tools: null,
          ...(agent.model !== undefined && { model: agent.model }),
        });
        sessions.sessions[String(id)] = {
          createdAt: Date.now(),
          agent: agent.kind,
          parent: { sessionId: String(api.conversationId), toolCallId: api.callId },
        };
        calls.calls[api.callId] = { kind: "delegate", sessionId: String(id), taskId: api.taskId };
        return id;
      }, context);
      const details: JsonValue = { sessionId: String(childId), agent: agent.kind };
      await api.details(details, context);
      const child = await api.conversation(childId, context);
      if (child === undefined) throw new Error(`The child session ${childId} of call ${api.callId} is gone`);
      await child.submit(
        {
          type: "input",
          content: parsed.data.task,
          requestId: `delegate:${api.callId}`,
          notify: { taskId: api.taskId, key: ANSWERED },
        },
        context,
      );
      return { sleep: { signals: [SubmissionSettled.key(ANSWERED)] } };
    },
  });
}

/** What a deferred call memoizes on its first run, so that every rerun starts the same work and waits as long. */
// A type alias, not an interface: a memo must be a pi `JsonValue`.
// oxlint-disable-next-line typescript/consistent-type-definitions
type Waiting = { token: string; until: number };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A deferred tool as pi-durable runs it: a replay-safe tool that parks on its reply. Its first run memoizes a token
 * and a deadline and records them in `CallsDoc`, from when its sleep is its own and not the gate's; then it resolves
 * the call's ports, runs `start` with a reply address, and parks until a reply arrives or the deadline passes. A rerun
 * after a crash starts the same work again, with the same request ID and token. Woken, it returns the reply.
 */
function toDeferred(tool: DeferredDefinition, { scope, ports: portsOf, portsFailed }: BindOptions): ToolRegistration {
  const { schema, offered } = tool.jsonSchema;
  /** What `start` and `cancel` get: the call's ports, resolved where it runs, and its reply address. */
  const contextOf = async (api: ToolExecutionApi, waiting: Waiting, signal: AbortSignal): Promise<DeferredContext> => {
    const sessionId = String(api.conversationId);
    const target: PortsTarget = { scope, sessionId, toolCallId: api.callId, toolName: tool.name, signal };
    let ports: unknown;
    try {
      ports = await portsOf(target);
    } catch (error) {
      portsFailed(target, error);
      throw new PortsUnavailableError(tool.name, error);
    }
    return {
      ports,
      signal,
      scope,
      sessionId,
      toolCallId: api.callId,
      requestId: `deferred:${scopeKey(scope)}:${sessionId}:${api.callId}`,
      replyTo: { scope, sessionId, toolCallId: api.callId, token: waiting.token },
    };
  };
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: offered,
    replay: "safe",
    ...(tool.executionMode !== undefined && { executionMode: tool.executionMode }),
    prepareArguments: (args: unknown) => omitOfferedNulls(schema, args) as Record<string, unknown>,
    async execute(args, api, context: Context) {
      const parsed = tool.parameters.safeParse(args);
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
      const reply = await api.readSignal(ReplySignal, REPLY_KEY, context);
      if (reply !== undefined && "value" in reply) {
        return { output: text(reply.value.text), ...(reply.value.isError && { isError: true }) };
      }
      if (reply !== undefined || api.wake?.reason === "time") {
        return { output: text("No reply came in time."), isError: true };
      }
      const waiting = await api.memo<Waiting>(
        "runtime.deferred",
        { token: newToken(), until: api.now() + tool.timeoutMs },
        context,
      );
      await api.commit(async (tx) => {
        const calls = await tx.doc(CallsDoc, api.conversationId);
        // A record under this id that names another task is an earlier call's.
        if (startedCall(calls.calls, api.callId, api.taskId) === undefined) {
          calls.calls[api.callId] = { kind: "reply", token: waiting.token, until: waiting.until, taskId: api.taskId };
        }
      }, context);
      const deferred = await contextOf(api, waiting, context.abortSignal ?? NEVER);
      try {
        await tool.start(parsed.data, deferred);
      } catch (error) {
        return { output: text(messageOf(error)), isError: true };
      }
      return { sleep: { signals: [ReplySignal.key(REPLY_KEY)], until: waiting.until } };
    },
    async cancel(args, api, context: Context) {
      const waiting = await api.memo<Waiting>("runtime.deferred", context);
      const parsed = tool.parameters.safeParse(args);
      if (tool.cancel === undefined || waiting === undefined || !parsed.success) return;
      let deferred: DeferredContext;
      try {
        deferred = await contextOf(api, waiting, context.abortSignal ?? NEVER);
      } catch {
        // Reported as `ports_failed`; without its ports the app's `cancel` cannot run.
        return;
      }
      await tool.cancel(parsed.data, deferred);
    },
  });
}

/**
 * Every agent of an instance as pi-durable extensions, one per agent, by kind: its tools, its prompt and its gate. A
 * conversation selects the one of its agent, after the app's extensions that select that agent, so a session sees its
 * own agent's tools and instructions, and no other agent's.
 */
export function agentExtensions(
  agents: ReadonlyMap<string, AgentDefinition>,
  options: BindOptions,
): ReadonlyMap<string, Extension> {
  const extensions = new Map<string, Extension>();
  for (const agent of agents.values()) {
    extensions.set(
      agent.kind,
      defineExtension({
        name: extensionName(agent),
        tools: agent.tools.map((tool) => {
          switch (tool.kind) {
            case "app":
              return toPiTool(tool, options);
            case "delegate":
              return toDelegate(tool, extensions, options.app);
            case "deferred":
              return toDeferred(tool, options);
          }
        }),
        sections: [section("agent", () => agent.instructions, { tag: false })],
        hooks: [
          approvalGate(agent, (name) => options.app.catalog.tool(agent.kind, name), options.nestedApprovalTimeoutMs),
        ],
      }),
    );
  }
  return extensions;
}
