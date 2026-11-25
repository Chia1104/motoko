// The proxy runs in a thread of its own, so its timers never wait behind the benchmark's event loop, and the event loop
// never waits behind them. A real network would make neither wait.

import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

interface Chunk {
  due: number;
  data: Buffer;
}

const { targetHost, targetPort } = workerData as { targetHost: string; targetPort: number };
let oneWayMs = 0;

/**
 * A timer sleeps until about 3 ms before the due time, and `setImmediate` covers the rest. Delivery is then late by
 * well under a millisecond, not by the timer granularity. macOS fires timers a millisecond or more late.
 */
class Pipe {
  readonly #to: Socket;
  readonly #queue: Chunk[] = [];
  #lastDue = 0;
  #notBefore: number;
  #armed = false;
  constructor(to: Socket, notBefore: number) {
    this.#to = to;
    this.#notBefore = notBefore;
  }
  push(data: Buffer): void {
    const now = performance.now();
    const due = Math.max(now + oneWayMs, this.#lastDue, this.#notBefore + oneWayMs);
    this.#lastDue = due;
    if (this.#queue.length === 0 && due <= now) {
      this.#to.write(data);
      return;
    }
    this.#queue.push({ due, data });
    this.#arm();
  }
  #arm(): void {
    if (this.#armed || this.#queue.length === 0) return;
    this.#armed = true;
    const wait = (this.#queue[0] as Chunk).due - performance.now();
    if (wait > 4) setTimeout(() => this.#fire(), wait - 3);
    else setImmediate(() => this.#fire());
  }
  #fire(): void {
    this.#armed = false;
    const now = performance.now();
    while (this.#queue.length > 0 && (this.#queue[0] as Chunk).due <= now) {
      this.#to.write((this.#queue.shift() as Chunk).data);
    }
    this.#arm();
  }
}

const sockets = new Set<Socket>();
let connections = 0;

const server = createServer((client) => {
  connections++;
  client.setNoDelay(true);
  const acceptedAt = performance.now();
  const upstream = connect(targetPort, targetHost);
  upstream.setNoDelay(true);
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  }
  const tcpHandshakeEndsAt = acceptedAt + 2 * oneWayMs;
  const toServer = new Pipe(upstream, tcpHandshakeEndsAt);
  const toClient = new Pipe(client, 0);
  client.on("data", (data: Buffer) => toServer.push(data));
  upstream.on("data", (data: Buffer) => toClient.push(data));
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  parentPort?.postMessage({
    type: "listening",
    port: typeof address === "object" && address !== null ? address.port : 0,
  });
});

parentPort?.on("message", (message: { type: string; oneWayMs?: number; id?: number }) => {
  if (message.type === "delay") {
    oneWayMs = message.oneWayMs ?? 0;
    parentPort?.postMessage({ type: "ack", id: message.id });
  } else if (message.type === "stats") {
    parentPort?.postMessage({ type: "ack", id: message.id, connections, open: sockets.size / 2 });
  } else if (message.type === "close") {
    for (const socket of sockets) socket.destroy();
    server.close(() => parentPort?.postMessage({ type: "ack", id: message.id }));
  }
});
