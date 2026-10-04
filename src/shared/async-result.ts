import { UniplsTimeoutError } from "./errors.ts";

export class AsyncResult<T> {
  #resulted = false;
  #promise: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (reason?: unknown) => void;
  #signal: AbortSignal;
  #controller = new AbortController();

  get promise(): Promise<T> {
    return this.#promise;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  get resulted(): boolean {
    return this.#resulted;
  }

  constructor(
    options: {
      signal?: AbortSignal;
      timeout?: number;
      finally?: () => void;
    } = {},
  ) {
    this.#promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.#promise.catch(() => {});

    const signals = [this.#controller.signal];

    if (options.signal) {
      signals.push(options.signal);
    }

    this.#signal = AbortSignal.any(signals);

    let timer: ReturnType<typeof setTimeout> | null = null;

    if (typeof options.timeout === "number" && options.timeout > 0) {
      timer = setTimeout(() => {
        this.#controller.abort(new UniplsTimeoutError());
      }, options.timeout);
    }

    const onAbort = () => {
      if (timer !== null) {
        clearTimeout(timer);
      }

      if (!this.#resulted) {
        this.#reject(this.#signal.reason);
      }

      this.#resulted = true;

      options.finally?.();
    };

    this.#signal.addEventListener("abort", onAbort, { once: true });

    if (this.#signal.aborted) {
      onAbort();
    }
  }

  resolve = (value: T) => {
    if (this.#resulted) {
      return;
    }

    this.#resulted = true;
    this.#resolve(value);
    this.#controller.abort(); // 関連する listener と timer を解放します。
  };

  reject = (reason?: unknown) => {
    if (this.#resulted) {
      return;
    }

    this.#resulted = true;
    this.#reject(reason);
    this.#controller.abort(); // 関連する listener と timer を解放します。
  };
}
