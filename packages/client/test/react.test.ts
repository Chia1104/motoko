import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { motokoClient, webSocketTransport } from "../src/index.ts";
import { useMotokoSession } from "../src/react.ts";
import type { MotokoSessionHandle } from "../src/react.ts";

import { FakeSocket } from "./fake-socket.ts";

// A light test, as the hook is thin: rendered once, it shows the client's state of the session and makes its calls.
// Following and folding are the client's, tested against a fake transport in client.test.ts.
describe("useMotokoSession", () => {
  it("renders the session as the client holds it, and makes the session's calls", () => {
    const socket = new FakeSocket();
    socket.open();
    const client = motokoClient(webSocketTransport(socket));
    client.follow("7", () => undefined);
    socket.reply(socket.last("subscribe"));
    socket.event("7", "7.1.1", { type: "user", messageId: "1", text: "Hi" });

    let handle: MotokoSessionHandle | undefined;
    function Session({ sessionId }: { readonly sessionId: string }) {
      handle = useMotokoSession(client, sessionId);
      return createElement("p", null, `${handle.status}: ${handle.view.items.length} item, ${handle.view.status}`);
    }
    expect(renderToString(createElement(Session, { sessionId: "7" }))).toBe("<p>live: 1 item, idle</p>");

    void handle!.submit("Go", { requestId: "r-1" });
    void handle!.withdraw("5");
    void handle!.decide([{ toolCallId: "t-1", approved: false, comment: "No" }]);
    void handle!.abort();
    void handle!.compact();
    void handle!.continue({ requestId: "r-2" });
    expect(socket.sent.slice(-6).map((call) => [call.method, call.params])).toEqual([
      ["submit", { sessionId: "7", text: "Go", requestId: "r-1" }],
      ["withdraw", { sessionId: "7", submissionId: "5" }],
      ["approve", { sessionId: "7", decisions: [{ toolCallId: "t-1", approved: false, comment: "No" }] }],
      ["abort", { sessionId: "7" }],
      ["compact", { sessionId: "7" }],
      ["continue", { sessionId: "7", requestId: "r-2" }],
    ]);
  });
});
