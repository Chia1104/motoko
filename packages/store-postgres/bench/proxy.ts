import { Worker } from "node:worker_threads";

export class DelayProxy {
  readonly #worker: Worker;
  readonly port: Promise<number>;
  #next = 0;
  readonly #pending = new Map<number, (value: Record<string, unknown>) => void>();
  #rttMs = 0;

  constructor(targetHost: string, targetPort: number) {
    this.#worker = new Worker(new URL("./proxy-worker.ts", import.meta.url), {
      workerData: { targetHost, targetPort },
    });
    this.#worker.unref();
    this.port = new Promise((resolve, reject) => {
      this.#worker.once("error", reject);
      this.#worker.on("message", (message: { type: string; port?: number; id?: number }) => {
        if (message.type === "listening") resolve(message.port ?? 0);
        else if (message.type === "ack" && message.id !== undefined) {
          this.#pending.get(message.id)?.(message as Record<string, unknown>);
          this.#pending.delete(message.id);
        }
      });
    });
  }

  #call(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.#next;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#worker.postMessage({ ...message, id });
    });
  }

  get rttMs(): number {
    return this.#rttMs;
  }

  async setRtt(rttMs: number): Promise<void> {
    this.#rttMs = rttMs;
    await this.#call({ type: "delay", oneWayMs: rttMs / 2 });
  }

  async stats(): Promise<{ connections: number; open: number }> {
    const reply = await this.#call({ type: "stats" });
    return { connections: Number(reply.connections), open: Number(reply.open) };
  }

  async close(): Promise<void> {
    await this.#call({ type: "close" });
    await this.#worker.terminate();
  }
}
