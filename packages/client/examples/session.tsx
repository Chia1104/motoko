// With React: a session's view and its calls, the same over either transport. The app makes its client once.
import { useState } from "react";

import type { MotokoClient } from "@chia1104/motoko-client";
import { useMotokoSession } from "@chia1104/motoko-client/react";

export function Session({ client, sessionId }: { readonly client: MotokoClient; readonly sessionId: string }) {
  const { view, status, submit, decide } = useMotokoSession(client, sessionId);
  const [draft, setDraft] = useState("");

  return (
    <section>
      {status === "connecting" && <p>Connecting…</p>}
      {status === "ended" && <p>This session is gone.</p>}
      {view.items.map((item) => {
        if (item.kind === "user" || item.kind === "assistant") return <p key={item.messageId}>{item.text}</p>;
        if (item.kind !== "tool" || !view.pendingApprovals.includes(item.toolCallId)) return null;
        return (
          <p key={item.toolCallId}>
            {item.label}
            <button onClick={() => void decide([{ toolCallId: item.toolCallId, approved: true }])}>Allow</button>
            <button onClick={() => void decide([{ toolCallId: item.toolCallId, approved: false }])}>Deny</button>
          </p>
        );
      })}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(draft);
          setDraft("");
        }}
      >
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </form>
    </section>
  );
}
