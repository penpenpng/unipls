import { AsyncResult } from "../async-result.ts";
import { AsyncResults, type UniplsSubscriber } from "../async-results.ts";
import type { EventBus } from "../event-bus.ts";

export class SingleOperationScope<T, TEvents extends Record<string, unknown>> {
  readonly #events;
  readonly #result;

  constructor(params: { events: EventBus<TEvents>; signal?: AbortSignal; timeout?: number }) {
    this.#events = params.events.spawnEventBusView();
    this.#result = new AsyncResult<T>({
      signal: params.signal,
      timeout: params.timeout,
      finally: () => {
        this.#events.dispose();
      },
    });
  }

  get events() {
    return this.#events;
  }

  get signal(): AbortSignal {
    return this.#result.signal;
  }

  get resulted(): boolean {
    return this.#result.resulted;
  }

  get promise(): Promise<T> {
    return this.#result.promise;
  }

  resolve = (value: T) => {
    this.#result.resolve(value);
  };

  reject = (reason?: unknown) => {
    this.#result.reject(reason);
  };
}

export class StreamOperationScope<T, TEvents extends Record<string, unknown>> {
  readonly #events;
  readonly #results;

  constructor(params: {
    events: EventBus<TEvents>;
    subscriber: UniplsSubscriber<T>;
    signal?: AbortSignal;
    finally?: () => void;
  }) {
    this.#events = params.events.spawnEventBusView();
    this.#results = new AsyncResults<T>({
      subscriber: params.subscriber,
      signal: params.signal,
      finally: () => {
        params.finally?.();
        this.#events.dispose();
      },
    });
  }

  get events() {
    return this.#events;
  }

  get signal(): AbortSignal {
    return this.#results.signal;
  }

  get resulted(): boolean {
    return this.#results.resulted;
  }

  handleMessage = (message: T) => {
    this.#results.handleMessage(message);
  };

  handleTerminator = (message: T) => {
    this.#results.handleTerminator(message);
  };

  handleError = (error: unknown) => {
    this.#results.handleError(error);
  };

  raiseFatalError = (error: unknown) => {
    this.#results.raiseFatalError(error);
  };

  unsubscribe = () => {
    this.#results.unsubscribe();
  };
}
