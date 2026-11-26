/**
 * Calls `iterator.next()` only once the call before it has settled, as an async generator does on its own. A
 * hand-written iterator may yield one value twice, or skip one, when a second call starts before the first settles.
 */
export function serialPulls<T>(iterator: AsyncIterator<T>): AsyncIterator<T> {
  let previous: Promise<unknown> = Promise.resolve();
  return {
    next() {
      const pull = previous.then(() => iterator.next());
      previous = pull.catch(() => undefined);
      return pull;
    },
  };
}
