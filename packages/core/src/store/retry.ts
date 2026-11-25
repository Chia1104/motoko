export const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));

/**
 * Runs an idempotent statement, and again after a transient connection failure, `attempts` times at most.
 * `isTransient` is the dialect's test for such a failure.
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
