/** Account assignment, opening and deletion share one ordered critical section. Input never waits here. */
export function createLifecycleLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T> | T): Promise<T> {
      const next = tail.then(operation);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
