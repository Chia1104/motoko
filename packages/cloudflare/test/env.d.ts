/// <reference types="@cloudflare/vitest-plugin/types" />

declare module "*?raw" {
  const text: string;
  export default text;
}

declare namespace Cloudflare {
  interface Env {
    MOTOKO: DurableObjectNamespace<import("./worker.ts").MotokoTestAgent>;
    CONFORMANCE: DurableObjectNamespace<import("./worker.ts").MotokoConformanceObject>;
    SOCKETS: DurableObjectNamespace<import("./worker.ts").MotokoSocketObject>;
  }
}
