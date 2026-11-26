export async function eventually(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function unhandledRejections(work: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (event: PromiseRejectionEvent) => void unhandled.push(event.reason);
  addEventListener("unhandledrejection", listener);
  try {
    await work();
    // workerd reports an unhandled rejection after the turn it happened in.
    await pause(100);
  } finally {
    removeEventListener("unhandledrejection", listener);
  }
  return unhandled;
}

/**
 * What an RPC call rejects with, awaited in a `try`. `expect(stub.call()).rejects` would leave a rejection of the RPC
 * promise unhandled in the test itself, whatever the object did.
 */
export async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("The call resolved");
}
