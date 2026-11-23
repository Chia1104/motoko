/**
 * Runs `work` and returns every error that nothing caught meanwhile, a macrotask past it, in place of the test runner,
 * which fails the run on one: such as an app listener's, which its caller reports as an `EventTarget` does.
 */
export async function uncaughtErrors(work: () => unknown): Promise<unknown[]> {
  const errors: unknown[] = [];
  const runners = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", (error) => errors.push(error));
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve));
  } finally {
    process.removeAllListeners("uncaughtException");
    for (const runner of runners) process.on("uncaughtException", runner);
  }
  return errors;
}
