import type { Call, CallError, CallErrorCode, CallMethod, CallResult } from "@chia1104/motoko-wire";

import {
  ApprovalNotPendingError,
  InstanceClosedError,
  InvalidCursorError,
  InvalidRequestError,
  LeaseHeldError,
  ReplyNotPendingError,
  SessionBusyError,
  SessionNotFoundError,
  SessionOwnedError,
} from "./errors.ts";
import type { AgentInstance } from "./runtime.ts";

/**
 * The call protocol (`@chia1104/motoko-wire`'s `callSchemas`) mapped onto an instance, free of any transport: the
 * transport parses a call, decides whether its caller may make it (`callSchemas[method].writes` for a readonly
 * caller, and the app's `authorize`), runs it here and frames what it answers.
 */

type CallOf<M extends CallMethod> = Extract<Call, { readonly method: M }>;

const handlers: {
  readonly [M in CallMethod]: (instance: AgentInstance, params: CallOf<M>["params"]) => Promise<CallResult<M>>;
} = {
  // An optional field zod parsed as absent is left out, not passed as `undefined`.
  createSession: (instance, { requestId }) => instance.createSession(requestId === undefined ? {} : { requestId }),
  listSessions: (instance) => instance.listSessions(),
  submit: (instance, { sessionId, text, requestId, whenBusy, replyTo }) =>
    instance.session(sessionId).submit({
      text,
      requestId,
      ...(whenBusy !== undefined && { whenBusy }),
      ...(replyTo !== undefined && { replyTo }),
    }),
  approve: (instance, { sessionId, decisions }) =>
    instance.session(sessionId).approve(
      decisions.map(({ toolCallId, approved, comment }) => ({
        toolCallId,
        approved,
        ...(comment !== undefined && { comment }),
      })),
    ),
  reply: (instance, { sessionId, toolCallId, token, text, isError }) =>
    instance.session(sessionId).reply({ toolCallId, token, text, ...(isError !== undefined && { isError }) }),
  abort: async (instance, { sessionId }) => {
    await instance.session(sessionId).abort();
    return null;
  },
  withdraw: (instance, { sessionId, submissionId }) => instance.session(sessionId).withdraw(submissionId),
  compact: async (instance, { sessionId, instructions }) => {
    await instance.session(sessionId).compact(instructions === undefined ? {} : { instructions });
    return null;
  },
  deleteSession: async (instance, { sessionId }) => {
    await instance.session(sessionId).delete();
    return null;
  },
};

/** Runs one parsed call on `instance`. It rejects with what the instance threw; `callErrorOf` reads it. */
export async function runCall<C extends Call>(instance: AgentInstance, call: C): Promise<CallResult<C["method"]>> {
  // SAFETY: a call's params are its method's, as `Call` pairs them.
  const handler = handlers[call.method] as (
    instance: AgentInstance,
    params: C["params"],
  ) => Promise<CallResult<C["method"]>>;
  return handler(instance, call.params);
}

/** The runtime's errors, by the code a client branches on. */
const CODES: readonly (readonly [abstract new (...args: never[]) => Error, CallErrorCode])[] = [
  [InvalidRequestError, "invalid_request"],
  [SessionNotFoundError, "session_not_found"],
  [SessionBusyError, "session_busy"],
  [SessionOwnedError, "session_owned"],
  [ApprovalNotPendingError, "approval_not_pending"],
  [ReplyNotPendingError, "reply_not_pending"],
  [InvalidCursorError, "invalid_cursor"],
  [InstanceClosedError, "instance_closed"],
  [LeaseHeldError, "lease_held"],
];

/**
 * What a call that failed with `error` answers. `undefined` for an error that is not one of the runtime's: it is not
 * the client's to read, so the transport reports it and answers `internal`.
 */
export function callErrorOf(error: unknown): CallError | undefined {
  for (const [type, code] of CODES) if (error instanceof type) return { code, message: error.message };
  return undefined;
}
