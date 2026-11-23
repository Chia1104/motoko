import { applyEvent, emptySessionView, streamItemSchema } from "@chia1104/motoko-wire";
import type { AgentSessionView, Cursor } from "@chia1104/motoko-wire";

/** A client folding a session's stream, whatever the transport (SSE, WebSocket, Electron IPC). */
export class SessionClient {
  view: AgentSessionView = emptySessionView();
  /** The last position folded; hand it back to resume, in this process or after a restart. */
  cursor: Cursor | undefined;

  /** Feed every message the transport delivers. */
  receive(message: unknown): void {
    const item = streamItemSchema.parse(message);
    this.view = applyEvent(this.view, item.event);
    this.cursor = item.cursor;
  }

  /** The calls an operator should decide now. */
  pendingCalls() {
    return this.view.items.filter(
      (item) => item.kind === "tool" && this.view.pendingApprovals.includes(item.toolCallId),
    );
  }
}
