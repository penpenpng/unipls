import { type UniplsSubscriber } from "../async-results.ts";
import { UniplsTimeoutError } from "../errors.ts";
import type { EventBus } from "../event-bus.ts";
import type { OperationId, OperationType, SessionId } from "../types.ts";
import { MessageDispatcher, type MessageDeliveryMode } from "./message-dispatcher.ts";

/** operation timeout の公開入力を検証します。 */
export function validateOperationTimeout(timeout: number | undefined): void {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new RangeError("timeout には有限の正数を指定してください。");
  }
}

class OperationResources<TMessage, TEvents extends Record<string, unknown>> {
  readonly events;
  readonly operation: OperationId;
  readonly operationType: OperationType;
  readonly session: SessionId;
  readonly signal: AbortSignal;
  #controller = new AbortController();
  #externalSignal?: AbortSignal;
  #onExternalAbort?: () => void;
  #timer?: ReturnType<typeof setTimeout>;
  #unregister: () => void;
  #cleaned = false;

  constructor(params: {
    events: EventBus<TEvents>;
    dispatcher: MessageDispatcher<TMessage>;
    session: SessionId;
    operationType: OperationType;
    mode?: MessageDeliveryMode;
    receive?: (message: TMessage) => void;
  }) {
    this.events = params.events.spawnEventBusView();
    this.session = params.session;
    this.operationType = params.operationType;
    this.signal = this.#controller.signal;
    const registration = params.dispatcher.register({
      session: params.session,
      operationType: params.operationType,
      mode: params.mode,
      receive: params.receive,
    });
    this.operation = registration.operation;
    this.#unregister = registration.unregister;
  }

  arm(params: {
    signal?: AbortSignal;
    timeout?: number;
    onAbort: (reason: unknown) => void;
    onTimeout: () => void;
  }): void {
    if (params.signal) {
      this.#externalSignal = params.signal;
      this.#onExternalAbort = () => params.onAbort(params.signal?.reason);
      params.signal.addEventListener("abort", this.#onExternalAbort, { once: true });
    }
    if (params.timeout !== undefined) {
      this.#timer = setTimeout(params.onTimeout, params.timeout);
    }
    if (params.signal?.aborted) {
      params.onAbort(params.signal.reason);
    }
  }

  cleanup(reason?: unknown): void {
    if (this.#cleaned) return;
    this.#cleaned = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#externalSignal && this.#onExternalAbort) {
      this.#externalSignal.removeEventListener("abort", this.#onExternalAbort);
    }
    this.#unregister();
    this.events.dispose();
    this.#controller.abort(reason);
  }
}

export class SingleOperationScope<T, TMessage, TEvents extends Record<string, unknown>> {
  readonly #resources;
  readonly #promise;
  #resolvePromise!: (value: T | PromiseLike<T>) => void;
  #rejectPromise!: (reason?: unknown) => void;
  #resulted = false;

  constructor(params: {
    events: EventBus<TEvents>;
    dispatcher: MessageDispatcher<TMessage>;
    session: SessionId;
    operationType: OperationType;
    mode?: MessageDeliveryMode;
    receive?: (message: TMessage) => void;
    signal?: AbortSignal;
    timeout?: number;
  }) {
    this.#resources = new OperationResources(params);
    this.#promise = new Promise<T>((resolve, reject) => {
      this.#resolvePromise = resolve;
      this.#rejectPromise = reject;
    });
    void this.#promise.catch(() => {});
    this.#resources.arm({
      signal: params.signal,
      timeout: params.timeout,
      onAbort: this.reject,
      onTimeout: () => this.reject(new UniplsTimeoutError()),
    });
  }

  get events() {
    return this.#resources.events;
  }

  get operation(): OperationId {
    return this.#resources.operation;
  }

  get operationType(): OperationType {
    return this.#resources.operationType;
  }

  get session(): SessionId {
    return this.#resources.session;
  }

  get signal(): AbortSignal {
    return this.#resources.signal;
  }

  get resulted(): boolean {
    return this.#resulted;
  }

  get promise(): Promise<T> {
    return this.#promise;
  }

  resolve = (value: T) => {
    if (this.#resulted) return;
    this.#resulted = true;
    this.#resources.cleanup();
    this.#resolvePromise(value);
  };

  reject = (reason?: unknown) => {
    if (this.#resulted) return;
    this.#resulted = true;
    this.#resources.cleanup(reason);
    this.#rejectPromise(reason);
  };
}

export class StreamOperationScope<T, TMessage, TEvents extends Record<string, unknown>> {
  readonly #resources;
  readonly #subscriber;
  #resulted = false;

  constructor(params: {
    events: EventBus<TEvents>;
    dispatcher: MessageDispatcher<TMessage>;
    session: SessionId;
    operationType: OperationType;
    mode: MessageDeliveryMode;
    receive: (message: TMessage) => void;
    subscriber: UniplsSubscriber<T>;
    signal?: AbortSignal;
    timeout?: number;
  }) {
    this.#subscriber = params.subscriber;
    this.#resources = new OperationResources(params);
    this.#resources.arm({
      signal: params.signal,
      timeout: params.timeout,
      onAbort: (reason) => this.#finish("aborted", reason),
      onTimeout: () => this.raiseFatalError(new UniplsTimeoutError()),
    });
  }

  get events() {
    return this.#resources.events;
  }

  get operation(): OperationId {
    return this.#resources.operation;
  }

  get operationType(): OperationType {
    return this.#resources.operationType;
  }

  get session(): SessionId {
    return this.#resources.session;
  }

  get signal(): AbortSignal {
    return this.#resources.signal;
  }

  get resulted(): boolean {
    return this.#resulted;
  }

  handleMessage = (message: T) => {
    if (!this.#resulted) this.#subscriber.onMessage?.(message);
  };

  handleTerminator = (message: T) => {
    this.#finish("terminated", undefined, message);
  };

  handleError = (error: unknown) => {
    if (!this.#resulted) this.#subscriber.onError?.(error);
  };

  raiseFatalError = (error: unknown) => {
    this.#finish("fatal-error", error);
  };

  unsubscribe = () => {
    this.#finish("unsubscribed");
  };

  #finish(
    reason: "terminated" | "unsubscribed" | "aborted" | "fatal-error",
    error?: unknown,
    message?: T,
  ): void {
    if (this.#resulted) return;
    this.#resulted = true;
    this.#resources.cleanup(error);
    try {
      if (reason === "terminated") this.#subscriber.onTerminated?.(message as T);
      if (reason === "unsubscribed") this.#subscriber.onUnsubscribed?.();
      if (reason === "aborted" || reason === "fatal-error") {
        this.#subscriber.onFatalError?.(error);
      }
    } catch (cause) {
      console.warn("購読の終了 callback でエラーが発生しました:", cause);
    }
    try {
      this.#subscriber.finally?.({ reason, error });
    } catch (cause) {
      console.warn("購読の finally callback でエラーが発生しました:", cause);
    }
  }
}
