import type { AgentWireEvent } from "@chia1104/motoko-wire";

import type { MotokoSocket } from "../src/index.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export interface SentCall {
  readonly type: string;
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** A connection the test drives: it opens, closes and delivers frames on cue, and keeps what the client sent. */
export class FakeSocket extends EventTarget implements MotokoSocket {
  readyState = CONNECTING;
  readonly sent: SentCall[] = [];

  open() {
    this.readyState = OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.readyState = CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  send(data: string) {
    if (this.readyState !== OPEN) throw new Error("Not open");
    this.sent.push(JSON.parse(data) as SentCall);
  }

  receive(frame: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) }),
    );
  }

  /** The last call of `method` sent. */
  last(method: string): SentCall {
    const call = this.sent.findLast((sent) => sent.method === method);
    if (call === undefined) throw new Error(`No ${method} sent`);
    return call;
  }

  reply(call: SentCall, result: unknown = null) {
    this.receive({ type: "motoko:result", id: call.id, result });
  }

  event(sessionId: string, cursor: string, event: AgentWireEvent) {
    this.receive({ type: "motoko:event", sessionId, cursor, event });
  }
}
