// The browser side: the Agents SDK's socket to the user's NotesAgent, and Motoko's session over it.
import { useAgent } from "agents/react";
import { useState } from "react";

import { motokoClient, webSocketTransport } from "@chia1104/motoko-client";
import { useMotokoSession } from "@chia1104/motoko-client/react";

export function NotesSession({ user, sessionId }: { readonly user: string; readonly sessionId: string }) {
  // The binding `NOTES` in kebab case, and the object named after the user: the routing Worker admits them alone.
  const agent = useAgent({ agent: "notes", name: user });
  // The socket's one client, the same at every render; over HTTP to a Node server it would be httpTransport's.
  const motoko = motokoClient(webSocketTransport(agent));
  // The session's view, folded from its events; after a reconnect it resumes from the last cursor it folded.
  const { view, status, submit, decide } = useMotokoSession(motoko, sessionId);
  const [draft, setDraft] = useState("");

  return (
    <section>
      {status === "connecting" && <p>Connecting…</p>}
      {status === "ended" && <p>This session is gone.</p>}
      {view.items.map((item) => {
        if (item.kind === "user" || item.kind === "assistant") {
          return <p key={item.messageId}>{item.text}</p>;
        }
        if (item.kind !== "tool") return null;
        const waiting = view.pendingApprovals.includes(item.toolCallId);
        return (
          <p key={item.toolCallId}>
            {item.label}: {item.status}
            {waiting && (
              <>
                <button onClick={() => void decide([{ toolCallId: item.toolCallId, approved: true }])}>Allow</button>
                <button onClick={() => void decide([{ toolCallId: item.toolCallId, approved: false }])}>Deny</button>
              </>
            )}
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
