// Non-normative support for the historical references in this directory tree.
import { timeout } from "./promise-timeout";

export class AwaitableQueue<T> {
  private queue: Array<{ value: T; resolve: () => void }> = [];
  private resolvers: Array<(value: T) => void> = [];

  /** Enqueue a value and return a promise, which is resolved when the value is dequeued. */
  async enqueue(value: T, options?: { timeout?: number }): Promise<void> {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift();
      if (resolve) {
        resolve(value);
      }
    } else {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.queue.push({ value, resolve });

      if (options?.timeout) {
        return timeout(promise, options.timeout);
      } else {
        return promise;
      }
    }
  }

  /** Dequeue a value if exists. Otherwise, wait for the next value. */
  async dequeue(options?: { timeout?: number }): Promise<T> {
    if (this.queue.length > 0) {
      const { value, resolve } = this.queue.shift()!;
      resolve();
      return value;
    }

    const { promise, resolve } = Promise.withResolvers<T>();

    this.resolvers.push(resolve);

    if (options?.timeout) {
      return timeout(promise, options.timeout).finally(() => {
        this.resolvers = this.resolvers.filter((r) => r !== resolve);
      });
    } else {
      return promise;
    }
  }

  dequeueSync(): T {
    if (this.queue.length > 0) {
      const { value, resolve } = this.queue.shift()!;
      resolve();
      return value;
    } else {
      throw new AwaitableQueueEmptyError();
    }
  }

  clear(): void {
    this.queue = [];
    this.resolvers = [];
  }
}

export class AwaitableQueueEmptyError extends Error {}
