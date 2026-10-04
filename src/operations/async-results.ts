import type {
  UniplsBufferOverflowError,
  UniplsDroppedError,
  UniplsOpenError,
  UniplsTimeoutError,
} from "../shared/errors.ts";
import { UniplsInvalidUsageError } from "../shared/errors.ts";

/** callback が同期的に例外を投げた後の購読継続方法です。 */
export type StreamCallbackErrorPolicy = "continue" | "unsubscribe";

/** AsyncIterable の buffer が満杯になった場合の処理方法です。 */
export type StreamBufferOverflowPolicy = "error" | "drop-oldest" | "drop-newest";

/** AsyncIterable が未処理メッセージを保持する方法です。 */
export type StreamBufferOptions =
  | number
  | "latest"
  | Readonly<{
      /** buffer が保持できるメッセージ数です。 */
      capacity: number;
      /** capacity を超えたメッセージの処理方法です。 */
      overflow: StreamBufferOverflowPolicy;
    }>;

/** callback でメッセージを受け取る stream の指定です。 */
export interface StreamCallbackDelivery<T> {
  /** 一致したメッセージごとに同期的に呼ばれます。戻り値や Promise の完了は待機しません。 */
  onMatch: (message: T) => unknown;
  /** `onMatch` が同期的に例外を投げた場合の処理方法です。既定値は `"continue"` です。 */
  callbackError?: StreamCallbackErrorPolicy;
  /** callback delivery では buffer を使用できません。 */
  buffer?: never;
}

/** AsyncIterable でメッセージを受け取る stream の指定です。 */
export interface StreamIteratorDelivery {
  /** callback を省略すると single-consumer の AsyncIterable を返します。 */
  onMatch?: never;
  /** callback error policy は callback delivery だけで使用できます。 */
  callbackError?: never;
  /**
   * 未処理メッセージを保持する有限 buffer です。既定値は capacity 64、overflow `"error"` です。
   * 数値は overflow `"error"` の shorthand、`"latest"` は capacity 1、drop-oldest の shorthand です。
   */
  buffer?: StreamBufferOptions;
}

/** stream が cleanup を完了した後の不変な終了結果です。 */
export type StreamFinalization<T = unknown> =
  | Readonly<{ ok: true; reason: "terminated"; message: T }>
  | Readonly<{ ok: true; reason: "unsubscribed" }>
  | Readonly<{ ok: true; reason: "closed" }>
  | Readonly<{ ok: false; reason: "aborted"; error: unknown }>
  | Readonly<{ ok: false; reason: "timeout"; error: UniplsTimeoutError }>
  | Readonly<{ ok: false; reason: "open-error"; error: UniplsOpenError }>
  | Readonly<{ ok: false; reason: "dropped"; error: UniplsDroppedError }>
  | Readonly<{
      ok: false;
      reason: "buffer-overflow";
      error: UniplsBufferOverflowError;
    }>
  | Readonly<{ ok: false; reason: "callback-error"; error: unknown }>
  | Readonly<{ ok: false; reason: "fatal-error"; error: unknown }>;

/** stream を明示的に終了し、その終了結果を待つための handle です。 */
export interface SubscriptionHandle<TFinalization = StreamFinalization> {
  /** local のメッセージ観測と関連 resource を終了します。remote 側の購読解除は送信しません。 */
  unsubscribe(): void;
  /** cleanup 後に一度だけ解決し、失敗時にも reject しません。 */
  readonly closed: Promise<TFinalization>;
}

/** 一つの consumer がメッセージを逐次取得できる stream handle です。 */
export interface AsyncSubscription<T, TFinalization = StreamFinalization<T>>
  extends AsyncIterable<T>, SubscriptionHandle<TFinalization> {}

/** AsyncIterable stream が既定で保持する未処理メッセージ数です。 */
export const DEFAULT_STREAM_BUFFER_CAPACITY = 64;

export interface NormalizedStreamBuffer {
  readonly capacity: number;
  readonly overflow: StreamBufferOverflowPolicy;
  readonly diagnosticStrategy?: "latest" | "drop-oldest" | "drop-newest";
}

/** @internal buffer 指定を検証し、実行時の設定へ正規化します。 */
export function normalizeStreamBuffer(
  buffer: StreamBufferOptions | undefined,
): NormalizedStreamBuffer {
  if (buffer === undefined) {
    return Object.freeze({ capacity: DEFAULT_STREAM_BUFFER_CAPACITY, overflow: "error" });
  }
  if (buffer === "latest") {
    return Object.freeze({
      capacity: 1,
      overflow: "drop-oldest",
      diagnosticStrategy: "latest",
    });
  }
  if (typeof buffer === "number") {
    validateCapacity(buffer);
    return Object.freeze({ capacity: buffer, overflow: "error" });
  }
  if (typeof buffer !== "object" || buffer === null) {
    throw new TypeError('buffer には数値、"latest"、または設定 object を指定してください。');
  }
  validateCapacity(buffer.capacity);
  if (
    buffer.overflow !== "error" &&
    buffer.overflow !== "drop-oldest" &&
    buffer.overflow !== "drop-newest"
  ) {
    throw new TypeError("buffer.overflow に未対応の値が指定されました。");
  }
  return Object.freeze({
    capacity: buffer.capacity,
    overflow: buffer.overflow,
    ...(buffer.overflow === "error" ? {} : { diagnosticStrategy: buffer.overflow }),
  });
}

function validateCapacity(capacity: number): void {
  if (!Number.isFinite(capacity) || !Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError("buffer capacity には有限の正の整数を指定してください。");
  }
}

export interface StreamDeliveryAdapter<T> {
  readonly handle: SubscriptionHandle<StreamFinalization<T>> | AsyncSubscription<T>;
  push(message: T): void;
  finish(finalization: StreamFinalization<T>): void;
}

/** @internal callback delivery を stream lifecycle へ接続します。 */
export class CallbackStreamDelivery<T> implements StreamDeliveryAdapter<T> {
  readonly handle: SubscriptionHandle<StreamFinalization<T>>;
  readonly #onMatch: (message: T) => unknown;
  readonly #policy: StreamCallbackErrorPolicy;
  readonly #onCallbackError: (cause: unknown, policy: StreamCallbackErrorPolicy) => void;

  constructor(params: {
    onMatch: (message: T) => unknown;
    policy: StreamCallbackErrorPolicy;
    unsubscribe: () => void;
    closed: Promise<StreamFinalization<T>>;
    onCallbackError: (cause: unknown, policy: StreamCallbackErrorPolicy) => void;
  }) {
    this.#onMatch = params.onMatch;
    this.#policy = params.policy;
    this.#onCallbackError = params.onCallbackError;
    this.handle = Object.freeze({ unsubscribe: params.unsubscribe, closed: params.closed });
  }

  push(message: T): void {
    try {
      this.#onMatch(message);
    } catch (cause) {
      this.#onCallbackError(cause, this.#policy);
    }
  }

  finish(): void {}
}

interface PendingIteratorResult<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (reason: unknown) => void;
}

/** @internal single-consumer AsyncIterable delivery を stream lifecycle へ接続します。 */
export class AsyncStreamDelivery<T> implements StreamDeliveryAdapter<T> {
  readonly handle: AsyncSubscription<T>;
  readonly #buffer: NormalizedStreamBuffer;
  readonly #messages: T[] = [];
  readonly #onOverflow: () => void;
  readonly #onDropped: (
    strategy: "latest" | "drop-oldest" | "drop-newest",
    capacity: number,
  ) => void;
  #pending?: PendingIteratorResult<T>;
  #finalization?: StreamFinalization<T>;
  #iteratorCreated = false;

  constructor(params: {
    buffer: NormalizedStreamBuffer;
    unsubscribe: () => void;
    closed: Promise<StreamFinalization<T>>;
    onOverflow: () => void;
    onDropped: (strategy: "latest" | "drop-oldest" | "drop-newest", capacity: number) => void;
  }) {
    this.#buffer = params.buffer;
    this.#onOverflow = params.onOverflow;
    this.#onDropped = params.onDropped;
    this.handle = Object.freeze({
      unsubscribe: params.unsubscribe,
      closed: params.closed,
      [Symbol.asyncIterator]: () => {
        if (this.#iteratorCreated) {
          throw new UniplsInvalidUsageError(
            "AsyncSubscription から取得できる iterator は一つだけです。",
          );
        }
        this.#iteratorCreated = true;
        const iterator: AsyncIterableIterator<T> = {
          next: () => this.#next(),
          return: async () => {
            params.unsubscribe();
            return { done: true, value: undefined };
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return iterator;
      },
    });
  }

  push(message: T): void {
    if (this.#finalization) {
      return;
    }
    if (this.#pending) {
      const pending = this.#pending;
      this.#pending = undefined;
      pending.resolve({ done: false, value: message });
      return;
    }
    if (this.#messages.length < this.#buffer.capacity) {
      this.#messages.push(message);
      return;
    }
    if (this.#buffer.overflow === "error") {
      this.#onOverflow();
      return;
    }
    const strategy = this.#buffer.diagnosticStrategy;
    if (!strategy) {
      throw new Error("Lossy buffer strategy is missing");
    }
    if (this.#buffer.overflow === "drop-oldest") {
      this.#messages.shift();
      this.#messages.push(message);
    }
    this.#onDropped(strategy, this.#buffer.capacity);
  }

  finish(finalization: StreamFinalization<T>): void {
    if (this.#finalization) {
      return;
    }
    this.#finalization = finalization;
    this.#messages.length = 0;
    if (!this.#pending) {
      return;
    }
    const pending = this.#pending;
    this.#pending = undefined;
    if (finalization.ok) {
      pending.resolve({ done: true, value: undefined });
    } else {
      pending.reject(finalization.error);
    }
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#messages.length > 0) {
      return Promise.resolve({ done: false, value: this.#messages.shift() as T });
    }
    if (this.#finalization) {
      return this.#finalization.ok
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.#finalization.error);
    }
    if (this.#pending) {
      return Promise.reject(
        new UniplsInvalidUsageError("同じ iterator で複数の next() を同時に待つことはできません。"),
      );
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }
}
