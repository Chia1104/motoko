import type { StorageScope } from "./host.ts";

/** Base class of the errors the runtime throws on purpose. */
export class AgentRuntimeError extends Error {
  override readonly name: string = "AgentRuntimeError";
}

/** Another writer holds the scope's lease; acquiring it again fails with this. */
export class LeaseHeldError extends AgentRuntimeError {
  override readonly name = "LeaseHeldError";
  readonly scope: StorageScope;
  constructor(scope: StorageScope) {
    super(`Another writer holds agent instance ${scope.kind}/${scope.name}`);
    this.scope = scope;
  }
}

/** The instance lost its lease, or the runtime was closed: nothing is written through it any more. */
export class InstanceClosedError extends AgentRuntimeError {
  override readonly name = "InstanceClosedError";
  readonly scope: StorageScope;
  readonly reason: "closed" | "lease_lost" | "failed";
  constructor(scope: StorageScope, reason: "closed" | "lease_lost" | "failed") {
    const why = reason === "closed" ? "" : reason === "lease_lost" ? ": its lease was lost" : ": its storage failed";
    super(`Agent instance ${scope.kind}/${scope.name} is closed${why}`);
    this.scope = scope;
    this.reason = reason;
  }
}

export class SessionNotFoundError extends AgentRuntimeError {
  override readonly name = "SessionNotFoundError";
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`);
    this.sessionId = sessionId;
  }
}

/**
 * `submit`, `configure` or `delete` of a child session: only its delegate submits to it, and it goes with its parent.
 */
export class SessionOwnedError extends AgentRuntimeError {
  override readonly name = "SessionOwnedError";
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Session ${sessionId} is a child session: its delegate's call owns it`);
    this.sessionId = sessionId;
  }
}

/** `submit` with `whenBusy: "reject"` while a run is going. */
export class SessionBusyError extends AgentRuntimeError {
  override readonly name = "SessionBusyError";
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Session ${sessionId} is busy`);
    this.sessionId = sessionId;
  }
}

/** A call's input the runtime refuses as it is, as a transport refuses one that does not parse. */
export class InvalidRequestError extends AgentRuntimeError {
  override readonly name = "InvalidRequestError";
}

/** A decision for a call that is not waiting for one. */
export class ApprovalNotPendingError extends AgentRuntimeError {
  override readonly name = "ApprovalNotPendingError";
  readonly toolCallId: string;
  constructor(toolCallId: string) {
    super(`Tool call ${toolCallId} is not waiting for an approval`);
    this.toolCallId = toolCallId;
  }
}

/** A reply to a call that waits for none, or with a token that is not the call's: the two are not told apart. */
export class ReplyNotPendingError extends AgentRuntimeError {
  override readonly name = "ReplyNotPendingError";
  readonly toolCallId: string;
  constructor(toolCallId: string) {
    super(`Tool call ${toolCallId} is not waiting for this reply`);
    this.toolCallId = toolCallId;
  }
}

/**
 * The app's `modelsFor` threw or rejected for an instance, so a model request had no model access.
 * The run it served ends with this message; the cause is in `cause` and in the instance's reports.
 */
export class ModelsUnavailableError extends AgentRuntimeError {
  override readonly name = "ModelsUnavailableError";
  readonly scope: StorageScope;
  constructor(scope: StorageScope, cause: unknown) {
    super(`No model access for agent instance ${scope.kind}/${scope.name}: the app could not resolve its models`, {
      cause,
    });
    this.scope = scope;
  }
}

/**
 * The app's `portsFor` threw or rejected for one tool call: the call ends with this message as its
 * error result, which the model reads. The cause is in `cause` and in the instance's reports.
 */
export class PortsUnavailableError extends AgentRuntimeError {
  override readonly name = "PortsUnavailableError";
  readonly toolName: string;
  constructor(toolName: string, cause: unknown) {
    super(`Tool \`${toolName}\` could not run: the app could not provide what it needs for this call`, { cause });
    this.toolName = toolName;
  }
}

export class InvalidCursorError extends AgentRuntimeError {
  override readonly name = "InvalidCursorError";
  readonly cursor: string;
  constructor(cursor: string) {
    super(`Not a cursor of this session's stream: ${cursor}`);
    this.cursor = cursor;
  }
}
