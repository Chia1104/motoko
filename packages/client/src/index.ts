/**
 * `@chia1104/motoko-client`: Motoko from the browser, one client over every transport. It follows sessions, folding
 * their events into a session view with `@chia1104/motoko-wire`'s `applyEvent` and resuming each from its last cursor
 * when its connection drops, and makes the calls an app needs: over a WebSocket to a Durable Object
 * (`webSocketTransport`) or HTTP and server-sent events to a Node server (`httpTransport`). It imports no server, Agents
 * SDK, pi or Node code.
 */
export { motokoClient, MotokoError } from "./client.ts";
export type {
  ApprovalDecision,
  ApprovalOutcome,
  ContinueOptions,
  CreateSessionOptions,
  FollowListener,
  MotokoClient,
  MotokoSessionState,
  MotokoSessionStatus,
  MotokoTransport,
  ReplyInput,
  ReplyResult,
  SessionInfo,
  SubmitInput,
  SubmitResult,
  WithdrawResult,
} from "./client.ts";
export { httpTransport } from "./http.ts";
export type { HttpHeaders, HttpTransportOptions } from "./http.ts";
export { webSocketTransport } from "./web-socket.ts";
export type { MotokoSocket } from "./web-socket.ts";
export type { MotokoErrorCode } from "@chia1104/motoko-wire/socket";
