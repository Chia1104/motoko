/** The wait after failed attempt `attempt` (from 1): 100 ms, doubling with each attempt. */
export const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));

/**
 * Runs an idempotent statement, again after a transient connection failure (`isTransient`, the dialect's), `attempts`
 * times at most.
 */
export async function retry<T>(
  attempts: number,
  isTransient: (error: unknown) => boolean,
  run: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isTransient(error) || attempt >= attempts) throw error;
      await backoff(attempt);
    }
  }
}
