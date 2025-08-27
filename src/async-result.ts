import { UniplsTimeoutError } from './errors';

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

  constructor(params: AsyncResultParams) {
    this.#promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });

    const signals = [this.#controller.signal];
    if (params.signal) {
      signals.push(params.signal);
    }
    this.#signal = AbortSignal.any(signals);

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (typeof params.timeout === 'number' && params.timeout > 0) {
      timer = setTimeout(() => {
        this.#controller.abort(new UniplsTimeoutError());
      }, params.timeout);
    }

    const cleanup = () => {
      this.#signal.removeEventListener('abort', cleanup);

      if (timer !== null) {
        clearTimeout(timer);
      }
      if (!this.#resulted) {
        this.#reject(this.#signal.reason);
      }
      this.#resulted = true;
      params.finally();
    };

    this.#signal.addEventListener('abort', cleanup);
  }

  resolve = (value: T) => {
    if (this.#resulted) {
      return;
    }
    this.#resulted = true;
    this.#resolve(value);
    this.#controller.abort(); // For cleanup
  };

  reject = (reason?: unknown) => {
    if (this.#resulted) {
      return;
    }
    this.#resulted = true;
    this.#reject(reason);
    this.#controller.abort(); // For cleanup
  };
}

export interface AsyncResultParams {
  signal?: AbortSignal;
  timeout?: number;
  finally: () => void;
}
