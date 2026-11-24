/**
 * `@chia1104/motoko-core`: agent definitions, the host contract and `createAgentRuntime`. Runtime-agnostic: it uses no
 * Node built-ins, so it runs in a Node process, Electron or a Durable Object.
 *
 * Motoko exports what it adds. pi itself (models and providers, storages, `Storage`, `Wake`,
 * `ModelRef`, `Report`) is a peer dependency the app installs and imports from `@earendil-works/*`;
 * pi types appear in Motoko's signatures where Motoko passes them through.
 */
export { defineAgent } from "./agent.ts";
export type { AgentDefinition, AgentDefinitionInput, AgentPolicy } from "./agent.ts";
export {
  AgentRuntimeError,
  ApprovalNotPendingError,
  InstanceClosedError,
  InvalidCursorError,
  InvalidRequestError,
  LeaseHeldError,
  ModelsUnavailableError,
  PortsUnavailableError,
  ReplyNotPendingError,
  SessionBusyError,
  SessionNotFoundError,
  SessionOwnedError,
} from "./errors.ts";
export { callErrorOf, runCall } from "./call.ts";
export { assertScope, inProcessLeases, scopeKey } from "./host.ts";
export type { AgentHost, AgentStore, HostWake, Lease, StorageScope } from "./host.ts";
export { createAgentRuntime } from "./runtime.ts";
export type { ApprovalDecision, ApprovalOutcome } from "./engine/approvals.ts";
export type { DeliverReply, OutgoingReply } from "./engine/asks.ts";
export type { AppExtension, ExtensionsResolver } from "./engine/extensions.ts";
export { runInputs } from "./engine/inputs.ts";
export type { RunInput } from "./engine/inputs.ts";
export type { ApprovalRule, ToolSelection } from "./engine/sessions.ts";
export type { InstanceInspection, InstanceState } from "./engine/lifecycle.ts";
export type { ReplyInput, ReplyResult } from "./engine/replies.ts";
export type { ReplyAddress } from "@chia1104/motoko-wire";
export type { ModelsResolver } from "./engine/models.ts";
export type {
  AgentInstance,
  AgentRuntime,
  AgentRuntimeModelsOption,
  AgentRuntimeOptions,
  AgentRuntimePortsOption,
  AgentSession,
  CompactOptions,
  ContinueInput,
  EventsOptions,
  InstanceReport,
  AgentRuntimeInspection,
  AgentRuntimeReportKind,
  RecoverOptions,
  RecoverResult,
  SessionChange,
  SessionInfo,
  SessionOptions,
  SessionSettings,
  SubmitInput,
  SubmitResult,
  WithdrawResult,
} from "./runtime.ts";
export { defineDeferredTool, defineDelegate, defineTool } from "./tool.ts";
export type {
  AppToolDefinition,
  DeferredContext,
  DeferredDefinition,
  DeferredSpec,
  DelegateDefinition,
  DelegateSpec,
  PortsResolver,
  PortsTarget,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolSpec,
} from "./tool.ts";
export type { ToolJsonSchema } from "./json-schema.ts";
