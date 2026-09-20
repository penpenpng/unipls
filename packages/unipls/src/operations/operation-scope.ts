import {
  AsyncStreamDelivery,
  CallbackStreamDelivery,
  type AsyncSubscription,
  type NormalizedStreamBuffer,
  type StreamCallbackErrorPolicy,
  type StreamDeliveryAdapter,
  type StreamFinalization,
  type SubscriptionHandle,
} from "../async-results.ts";
import {
  UniplsBufferOverflowError,
  UniplsClosedError,
  UniplsDroppedError,
  UniplsOpenError,
  UniplsTimeoutError,
} from "../errors.ts";
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
  #timeoutController?: AbortController;
  #onAbort?: () => void;
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
    signal?: AbortSignal;
    timeout?: number;
  }) {
    this.events = params.events.spawnEventBusView();
    this.session = params.session;
    this.operationType = params.operationType;
    const signals = [this.#controller.signal];
    if (params.signal) signals.push(params.signal);
    if (params.timeout !== undefined) {
      this.#timeoutController = new AbortController();
      signals.push(this.#timeoutController.signal);
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#timeoutController?.abort(new UniplsTimeoutError());
      }, params.timeout);
    }
    this.signal = AbortSignal.any(signals);
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
    onAbort: (reason: unknown) => void;
    onTimeout: (reason: UniplsTimeoutError) => void;
  }): void {
    this.#onAbort = () => {
      const timeoutReason = this.#timeoutController?.signal.reason;
      if (this.#timeoutController?.signal.aborted && this.signal.reason === timeoutReason) {
        params.onTimeout(timeoutReason as UniplsTimeoutError);
        return;
      }
      params.onAbort(this.signal.reason);
    };
    this.signal.addEventListener("abort", this.#onAbort, { once: true });
    if (this.signal.aborted) this.#onAbort();
  }

  cleanup(reason?: unknown): void {
    if (this.#cleaned) return;
    this.#cleaned = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#onAbort) this.signal.removeEventListener("abort", this.#onAbort);
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
      onAbort: this.reject,
      onTimeout: this.reject,
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
  readonly #closed;
  readonly #delivery: StreamDeliveryAdapter<T>;
  #resolveClosed!: (finalization: StreamFinalization<T>) => void;
  #resulted = false;

  constructor(params: {
    events: EventBus<TEvents>;
    dispatcher: MessageDispatcher<TMessage>;
    session: SessionId;
    operationType: OperationType;
    mode: MessageDeliveryMode;
    receive: (message: TMessage) => void;
    delivery:
      | Readonly<{
          type: "callback";
          next: (message: T) => unknown;
          policy: StreamCallbackErrorPolicy;
          onCallbackError: (cause: unknown, policy: StreamCallbackErrorPolicy) => void;
        }>
      | Readonly<{
          type: "iterator";
          buffer: NormalizedStreamBuffer;
          onMessageDropped: (
            strategy: "latest" | "drop-oldest" | "drop-newest",
            capacity: number,
          ) => void;
        }>;
    signal?: AbortSignal;
    timeout?: number;
  }) {
    this.#resources = new OperationResources(params);
    this.#closed = new Promise<StreamFinalization<T>>((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#delivery =
      params.delivery.type === "callback"
        ? new CallbackStreamDelivery({
            next: params.delivery.next,
            policy: params.delivery.policy,
            unsubscribe: this.unsubscribe,
            closed: this.#closed,
            onCallbackError: params.delivery.onCallbackError,
          })
        : new AsyncStreamDelivery({
            buffer: params.delivery.buffer,
            unsubscribe: this.unsubscribe,
            closed: this.#closed,
            onOverflow: () => this.raiseFatalError(new UniplsBufferOverflowError()),
            onDropped: params.delivery.onMessageDropped,
          });
    this.#resources.arm({
      onAbort: (reason) =>
        this.#finish(Object.freeze({ ok: false, reason: "aborted", error: reason })),
      onTimeout: this.raiseFatalError,
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

  get handle(): SubscriptionHandle<StreamFinalization<T>> | AsyncSubscription<T> {
    return this.#delivery.handle;
  }

  handleMessage = (message: T) => {
    if (!this.#resulted) this.#delivery.push(message);
  };

  handleTerminator = (message: T) => {
    this.#finish(Object.freeze({ ok: true, reason: "terminated", message }));
  };

  raiseFatalError = (error: unknown) => {
    const finalization: StreamFinalization<T> =
      error instanceof UniplsTimeoutError
        ? Object.freeze({ ok: false, reason: "timeout", error })
        : error instanceof UniplsOpenError
          ? Object.freeze({ ok: false, reason: "open-error", error })
          : error instanceof UniplsDroppedError
            ? Object.freeze({ ok: false, reason: "dropped", error })
            : error instanceof UniplsBufferOverflowError
              ? Object.freeze({ ok: false, reason: "buffer-overflow", error })
              : error instanceof UniplsClosedError
                ? Object.freeze({ ok: true, reason: "closed" })
                : Object.freeze({ ok: false, reason: "fatal-error", error });
    this.#finish(finalization);
  };

  unsubscribe = () => {
    this.#finish(Object.freeze({ ok: true, reason: "unsubscribed" }));
  };

  close = () => {
    this.#finish(Object.freeze({ ok: true, reason: "closed" }));
  };

  failCallback = (error: unknown) => {
    this.#finish(Object.freeze({ ok: false, reason: "callback-error", error }));
  };

  #finish(finalization: StreamFinalization<T>): boolean {
    if (this.#resulted) return false;
    this.#resulted = true;
    this.#resources.cleanup(finalization.ok ? undefined : finalization.error);
    this.#delivery.finish(finalization);
    this.#resolveClosed(finalization);
    return true;
  }
}
