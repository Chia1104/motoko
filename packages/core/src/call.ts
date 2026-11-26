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

const handlers: {
  readonly [M in CallMethod]: (instance: AgentInstance, params: Call<M>["params"]) => Promise<CallResult<M>>;
} = {
  createSession: (instance, { requestId }) => instance.createSession(requestId === undefined ? {} : { requestId }),
  listSessions: (instance) => instance.listSessions(),
  submit: (instance, { sessionId, text, requestId, whenBusy, replyTo }) =>
    instance.session(sessionId).submit({
      text,
      requestId,
      ...(whenBusy !== undefined && { whenBusy }),
      ...(replyTo !== undefined && { replyTo }),
    }),
  continue: (instance, { sessionId, requestId }) => instance.session(sessionId).continue({ requestId }),
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

/** Runs one parsed call on `instance`. It rejects with what the instance threw, which `callErrorOf` reads. */
export async function runCall<M extends CallMethod>(instance: AgentInstance, call: Call<M>): Promise<CallResult<M>> {
  return handlers[call.method](instance, call.params);
}

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
 * What a call that failed with `error` answers. It is `undefined` for an error that is not one of the runtime's. Such
 * an error is not the client's to read, so the transport reports it and answers `internal`.
 */
export function callErrorOf(error: unknown): CallError | undefined {
  for (const [type, code] of CODES) if (error instanceof type) return { code, message: error.message };
  return undefined;
}
