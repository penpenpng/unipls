import type { UniplsReconnector } from "./reconnector.ts";

/** 指数バックオフ再接続の設定です。 */
export interface ExponentialBackoffReconnectorOptions {
  /** 初回接続を除く最大再試行回数です。 */
  maxRetries: number;
  /** 最初の待機時間です。既定値は 1,000 ms です。 */
  baseDelay?: number;
  /** 待機時間の上限です。既定値は 30,000 ms です。 */
  maxDelay?: number;
}

/** 指数バックオフと full jitter を使って再接続します。 */
export class ExponentialBackoffReconnector implements UniplsReconnector {
  #options: Required<ExponentialBackoffReconnectorOptions>;

  constructor(options: ExponentialBackoffReconnectorOptions) {
    const baseDelay = options.baseDelay ?? 1_000;
    const maxDelay = options.maxDelay ?? 30_000;
    if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
      throw new RangeError("maxRetries は0以上の整数を指定してください。");
    }
    if (!Number.isFinite(baseDelay) || baseDelay < 0) {
      throw new RangeError("baseDelay は0以上の有限数を指定してください。");
    }
    if (!Number.isFinite(maxDelay) || maxDelay < 0) {
      throw new RangeError("maxDelay は0以上の有限数を指定してください。");
    }
    this.#options = { maxRetries: options.maxRetries, baseDelay, maxDelay };
  }

  setup(
    { reconnect, exhaust }: Parameters<UniplsReconnector["setup"]>[0],
    context: Parameters<UniplsReconnector["setup"]>[1],
  ) {
    if (context.attempt > this.#options.maxRetries) {
      exhaust(context.cause);
      return;
    }

    const exponentialDelay = Math.min(
      this.#options.baseDelay * 2 ** (context.attempt - 1),
      this.#options.maxDelay,
    );
    const delay = Math.floor(Math.random() * exponentialDelay);
    const timer = setTimeout(reconnect, delay);
    const abort = () => clearTimeout(timer);
    context.signal.addEventListener("abort", abort, { once: true });
    return () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    };
  }
}
