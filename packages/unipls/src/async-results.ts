import { UniplsClosedError, UniplsDroppedError } from './errors.ts';
import type { WebSocketData } from './types.ts';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Used by JSDoc
import type { Unipls } from './unipls.ts';

export class AsyncResults<T> {
  #resulted = false;
  #reason: SubscriptionEndReason = 'fatal-error';
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
        'abort',
        () => {
          this.abort(signal.reason);
        },
        { once: true },
      );
    }

    this.signal.addEventListener(
      'abort',
      () => {
        if (!this.#resulted) {
          this.#error = this.signal.reason;
          this.#reason = 'fatal-error';
          this.#subscriber.onFatalError?.(this.#error);
        }
        this.#resulted = true;

        try {
          this.#subscriber.finally?.({
            reason: this.#reason,
            error: this.#error,
          });
        } catch (err) {
          console.warn(
            'An error occurred while processing finally callback:',
            err,
          );
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
    this.#reason = 'terminated';
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
        return 'closed';
      } else if (error instanceof UniplsDroppedError) {
        return 'dropped';
      } else {
        return 'fatal-error';
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
    this.#reason = 'aborted';
    this.#subscriber.onFatalError?.(reason);
    this.#controller.abort();
  }

  unsubscribe = (): void => {
    if (this.#resulted) {
      return;
    }
    this.#resulted = true;
    this.#reason = 'unsubscribed';
    this.#subscriber.onUnsubscribed?.();
    this.#controller.abort();
  };
}

/** {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の必須の引数で、購読者を定義します。 */
export interface UniplsSubscriber<TOutput = WebSocketData> {
  /** 購読の対象となるメッセージを観測したときに実行されるコールバックを指定します。 */
  onMessage?: (data: TOutput) => void;

  /** 購読の終端となるメッセージを観測したときに実行されるコールバックを指定します。 */
  onTerminated?: (data: TOutput) => void;

  /** 購読の対象となるメッセージがエラーを引き起こしたときに実行されるコールバックを指定します。このエラーは、典型的には `deserializer` によって発生し得ます。 */
  onError?: (error: unknown) => void;

  onUnsubscribed?: () => void;

  onFatalError?: (error: unknown) => void;

  /** 購読が終了したときに実行されるコールバックを指定します。 */
  finally?: (ctx: SubscriptionFinalizationContext) => void;
}

export interface SubscriptionFinalizationContext {
  /** 購読が終了した理由を表します。 */
  reason: SubscriptionEndReason;

  /** `reason === 'fatal-error'` の場合のみ、購読が終了した原因となったエラーを表します。 */
  error?: unknown;
}

export type SubscriptionEndReason =
  | 'closed'
  | 'dropped'
  | 'unsubscribed'
  | 'terminated'
  | 'aborted'
  | 'fatal-error';
