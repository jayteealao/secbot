/**
 * Runs operations in call order. An operation starts at once when nothing is running or
 * waiting; otherwise it waits for everything before it. An asynchronous operation holds the
 * queue until it settles.
 *
 * Ported from pi-durable v1.0.3 `packages/durable/src/storage/sqlite/node.ts`
 * (`class SerialOperationQueue`, MIT, Earendil Works). The class is not exported there
 * (source: node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js has no export
 * of it), so it is copied rather than imported.
 */
const ignore = (): void => {};

export class SerialOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => T): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    this.pending++;
    // Publish the barrier before the operation starts, so calls it makes synchronously wait behind it.
    const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
    this.tail = barrier;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.pending--;
      releaseBarrier();
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.pending++;
    const settled = this.tail.then(operation).finally(() => {
      this.pending--;
    });
    this.tail = settled.then(ignore, ignore);
    return settled;
  }
}
