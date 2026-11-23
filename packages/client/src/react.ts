/**
 * `@chia1104/motoko-client/react`: `useMotokoSession`, a thin hook over the client. React is an optional peer; nothing
 * else here needs it.
 */
import { useCallback, useSyncExternalStore } from "react";

import type {
  ApprovalDecision,
  ApprovalOutcome,
  MotokoClient,
  MotokoSessionState,
  SubmitInput,
  SubmitResult,
  WithdrawResult,
} from "./client.ts";

export interface MotokoSessionHandle extends MotokoSessionState {
  /**
   * `requestId` defaults to a fresh one: pass your own to make a retry of the same message idempotent. Pass
   * `whenBusy: "steer"` to have the run going on read it after its current tool round.
   */
  submit(text: string, options?: Partial<Omit<SubmitInput, "text">>): Promise<SubmitResult>;
  /** Takes back an input waiting in `view.queued`. */
  withdraw(submissionId: string): Promise<WithdrawResult>;
  decide(decisions: readonly ApprovalDecision[]): Promise<ApprovalOutcome[]>;
  abort(): Promise<void>;
  /** Summarizes the session's older messages; `view.compaction` shows it going on, or why it failed. */
  compact(instructions?: string): Promise<void>;
}

/**
 * Follows `sessionId` over `client`, whichever transport it has: its session view, folded from its events and resumed
 * from its cursor when the connection drops, and the calls on it. `status` is the follow's; the run's is `view.status`.
 */
export function useMotokoSession(client: MotokoClient, sessionId: string): MotokoSessionHandle {
  const follow = useCallback((onChange: () => void) => client.follow(sessionId, onChange), [client, sessionId]);
  const read = () => client.sessionState(sessionId);
  const state = useSyncExternalStore(follow, read, read);
  const submit = useCallback(
    (text: string, options?: Partial<Omit<SubmitInput, "text">>) =>
      client.submit(sessionId, { ...options, text, requestId: options?.requestId ?? crypto.randomUUID() }),
    [client, sessionId],
  );
  const decide = useCallback(
    (decisions: readonly ApprovalDecision[]) => client.approve(sessionId, decisions),
    [client, sessionId],
  );
  const withdraw = useCallback((submissionId: string) => client.withdraw(sessionId, submissionId), [client, sessionId]);
  const abort = useCallback(() => client.abort(sessionId), [client, sessionId]);
  const compact = useCallback((instructions?: string) => client.compact(sessionId, instructions), [client, sessionId]);
  return { ...state, submit, withdraw, decide, abort, compact };
}
