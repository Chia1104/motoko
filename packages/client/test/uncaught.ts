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
