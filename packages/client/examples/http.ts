// Without React, over HTTP: a page beside a Node server that mounts motokoHandler at /motoko.
import { httpTransport, motokoClient } from "@chia1104/motoko-client";
import type { MotokoSessionState } from "@chia1104/motoko-client";

declare function render(state: MotokoSessionState): void;
/** The app's own sign-in: a short-lived token, refreshed as it expires. */
declare function accessToken(): Promise<string>;

const motoko = motokoClient(
  httpTransport({
    baseUrl: "/motoko",
    // Asked again for each request, a follow's reconnects too, so each carries a fresh token.
    headers: async () => ({ authorization: `Bearer ${await accessToken()}` }),
  }),
);

const { id } = await motoko.createSession();
const unfollow = motoko.follow(id, render);
await motoko.submit(id, { text: "Note that the milk is out.", requestId: crypto.randomUUID() });
// …and once the page is done with the session:
unfollow();
