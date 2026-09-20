import { UniplsClosedError, UniplsDroppedError } from "./errors.ts";
import type { WebSocketData } from "./types.ts";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- JSDoc のリンクで使用します。
import type { Unipls } from "./unipls.ts";

/** @internal 複数の非同期結果を購読 callback へ配送します。 */
export class AsyncResults<T> {
  #resulted = false;
  #reason: SubscriptionEndReason = "fatal-error";
  #error: unknown = null;
  #controller = new AbortController();
  #subscriber: UniplsSubscriber<T>;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get resulted(): boolean {
    return this.#resulted;
  }

  constructor(params: {
    subscriber: UniplsSubscriber<T>;
    signal?: AbortSignal;
    finally: () => void;
  }) {
    this.#subscriber = params.subscriber;

    if (params.signal) {
      const signal = params.signal;

      signal.addEventListener(
        "abort",
        () => {
          this.abort(signal.reason);
        },
        { once: true },
      );
    }

    this.signal.addEventListener(
      "abort",
      () => {
        if (!this.#resulted) {
          this.#error = this.signal.reason;
          this.#reason = "fatal-error";
          this.#subscriber.onFatalError?.(this.#error);
        }
        this.#resulted = true;

        try {
          this.#subscriber.finally?.({
            reason: this.#reason,
            error: this.#error,
          });
        } catch (err) {
          console.warn("An error occurred while processing finally callback:", err);
        }

        params.finally();
      },
      { once: true },
    );
  }

  handleMessage = (message: T): void => {
    if (this.#resulted) {
      return;
    }
    this.#subscriber.onMessage?.(message);
  };

  handleTerminator = (message: T): void => {
    if (this.#resulted) {
      return;
    }
    this.#resulted = true;
    this.#reason = "terminated";
    this.#subscriber.onTerminated?.(message);
    this.#controller.abort();
  };

  handleError = (error: unknown): void => {
    if (this.#resulted) {
      return;
    }
    this.#subscriber.onError?.(error);
  };

  raiseFatalError = (error: unknown): void => {
    if (this.#resulted) {
      return;
    }
    this.#resulted = true;
    this.#error = error;
    this.#reason = ((): SubscriptionEndReason => {
      if (error instanceof UniplsClosedError) {
        return "closed";
      } else if (error instanceof UniplsDroppedError) {
        return "dropped";
      } else {
        return "fatal-error";
      }
    })();
    this.#subscriber.onFatalError?.(error);
    this.#controller.abort();
  };

  abort(reason: unknown) {
    if (this.#resulted) {
      return;
    }

    this.#resulted = true;
    this.#error = reason;
    this.#reason = "aborted";
    this.#subscriber.onFatalError?.(reason);
    this.#controller.abort();
  }

  unsubscribe = (): void => {
    if (this.#resulted) {
      return;
    }
    this.#resulted = true;
    this.#reason = "unsubscribed";
    this.#subscriber.onUnsubscribed?.();
    this.#controller.abort();
  };
}

/** {@link Unipls.listen} または {@link Unipls.subscribe} が通知する callback を指定します。 */
export interface UniplsSubscriber<TOutput = WebSocketData> {
  /** 購読の対象となるメッセージを観測したときに実行されるコールバックを指定します。 */
  onMessage?: (data: TOutput) => void;

  /** 購読の終端となるメッセージを観測したときに実行されるコールバックを指定します。 */
  onTerminated?: (data: TOutput) => void;

  /** 購読中に回復可能なエラーを観測したときに呼ばれます。 */
  onError?: (error: unknown) => void;

  /** 利用者の unsubscribe によって購読が終了したときに呼ばれます。 */
  onUnsubscribed?: () => void;

  /** 購読を継続できないエラーで終了したときに呼ばれます。 */
  onFatalError?: (error: unknown) => void;

  /** 購読が終了したときに実行されるコールバックを指定します。 */
  finally?: (ctx: SubscriptionFinalizationContext) => void;
}

/** 購読終了時に `finally` callback へ渡される情報です。 */
export interface SubscriptionFinalizationContext {
  /** 購読が終了した理由を表します。 */
  reason: SubscriptionEndReason;

  /** `reason === 'fatal-error'` の場合のみ、購読が終了した原因となったエラーを表します。 */
  error?: unknown;
}

/** 購読が終了した理由です。 */
export type SubscriptionEndReason =
  | "closed"
  | "dropped"
  | "unsubscribed"
  | "terminated"
  | "aborted"
  | "fatal-error";
