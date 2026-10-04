export class ObservationQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(value: T) => void> = [];

  get size(): number {
    return this.#values.length;
  }

  push(value: T): void {
    const waiter = this.#waiters.shift();

    if (waiter) {
      waiter(value);

      return;
    }

    this.#values.push(value);
  }

  take(): T {
    const value = this.#values.shift();

    if (value === undefined) {
      throw new Error("No observation is available");
    }

    return value;
  }

  next(): Promise<T> {
    if (this.#values.length > 0) {
      return Promise.resolve(this.take());
    }

    return new Promise<T>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

/** 現行の競合テストが使う有限の Promise chain を進めます。各段階で1回呼び出します。 */
export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
