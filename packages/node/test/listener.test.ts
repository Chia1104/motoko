import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { nodeListener } from "../src/index.ts";
import type { FetchHandler } from "../src/index.ts";

import { eventually } from "./helpers.ts";

const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

async function listen(handler: FetchHandler, onError?: (error: unknown) => void): Promise<string> {
  const server = createServer(nodeListener(handler, { ...(onError !== undefined && { onError }) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("nodeListener", () => {
  it("hands the handler the request as the client sent it, and sends its response back", async () => {
    const base = await listen(async (request) => {
      const url = new URL(request.url);
      const headers = new Headers({ "x-seen": request.headers.get("x-sent") ?? "" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return Response.json(
        { method: request.method, path: `${url.pathname}${url.search}`, body: await request.text() },
        { status: 201, headers },
      );
    });

    const response = await fetch(`${base}/some/path?x=1`, {
      method: "POST",
      headers: { "x-sent": "hello" },
      body: "the body",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-seen")).toBe("hello");
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(await response.json()).toEqual({ method: "POST", path: "/some/path?x=1", body: "the body" });
  });

  it("aborts the request's signal and cancels the body when the client goes away", async () => {
    let aborted = false;
    let cancelled = false;
    const base = await listen(async (request) => {
      request.signal.addEventListener("abort", () => (aborted = true));
      return new Response(
        new ReadableStream({
          cancel: () => void (cancelled = true),
        }),
      );
    });
    const client = new AbortController();
    const response = await fetch(base, { signal: client.signal });
    expect(response.status).toBe(200);
    await wait(50);
    expect({ aborted, cancelled }).toEqual({ aborted: false, cancelled: false });

    client.abort();
    await eventually(() => aborted && cancelled);
  });

  it("writes the body only as fast as the client reads it", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const base = await listen(
      async () =>
        new Response(
          new ReadableStream({
            pull: (controller) => {
              pulled += 1;
              controller.enqueue(chunk);
            },
          }),
        ),
    );
    const client = new AbortController();
    const response = await fetch(base, { signal: client.signal });

    // The client reads nothing: once the buffers between them fill, the body is pulled no more.
    await wait(300);
    const stalled = pulled;
    await wait(300);
    expect(pulled).toBe(stalled);
    expect(stalled).toBeLessThan(512);

    // Reading drains them, and the body is pulled again.
    const reader = response.body!.getReader();
    for (let read = 0; read < 4 * 1024 * 1024;) read += (await reader.read()).value?.length ?? 0;
    await eventually(() => pulled > stalled);
    client.abort();
  });

  it("answers 500 when the handler rejects, and reports it", async () => {
    const reported: unknown[] = [];
    const failure = new Error("handler bug");
    const base = await listen(
      async () => {
        throw failure;
      },
      (error) => reported.push(error),
    );

    const response = await fetch(base);
    expect(response.status).toBe(500);
    expect(reported).toEqual([failure]);
  });
});
