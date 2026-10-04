import type { UniplsReconnector, UniplsReconnectorActions } from "./reconnector.ts";

/** 指数 backoff で再接続する reconnector の設定です。 */
export interface ExponentialBackoffReconnectorOptions {
  /** 初回接続を除く最大再試行回数です。省略時は無制限です。 */
  maxRetries?: number;
  /** 最初の待機時間 (ms) です。既定値は 1,000 です。 */
  initialDelay?: number;
  /** 待機時間の上限 (ms) です。既定値は 30,000 です。 */
  maxDelay?: number;
  /** 指数の底です。既定値は 2 です。 */
  factor?: number;
  /** 乱数源です。テストなどで再現可能な jitter に利用できます。 */
  random?: () => number;
}

/** 指数 backoff と full jitter を使って再接続し、任意の再試行上限で終了します。 */
export class ExponentialBackoffReconnector implements UniplsReconnector {
  readonly #maxRetries: number;
  readonly #initialDelay: number;
  readonly #maxDelay: number;
  readonly #factor: number;
  readonly #random: () => number;

  constructor(options: ExponentialBackoffReconnectorOptions = {}) {
    this.#maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY;
    this.#initialDelay = options.initialDelay ?? 1_000;
    this.#maxDelay = options.maxDelay ?? 30_000;
    this.#factor = options.factor ?? 2;
    this.#random = options.random ?? Math.random;

    if (!(this.#maxRetries >= 0)) {
      throw new RangeError("maxRetries は0以上で指定してください。");
    }
    if (!(this.#initialDelay >= 0)) {
      throw new RangeError("initialDelay は0以上で指定してください。");
    }
    if (!(this.#maxDelay >= 0)) {
      throw new RangeError("maxDelay は0以上で指定してください。");
    }
    if (!(this.#factor >= 1)) {
      throw new RangeError("factor は1以上で指定してください。");
    }
  }

  setup(
    { reconnect, exhaust }: UniplsReconnectorActions,
    context: Parameters<UniplsReconnector["setup"]>[1],
  ) {
    // context.attempt は失敗した接続試行の番号で、初回失敗は1です。
    const retriesUsed = context.attempt - 1;

    if (retriesUsed >= this.#maxRetries) {
      exhaust(context.cause);

      return;
    }

    const retryNumber = retriesUsed + 1;
    const ceiling = Math.min(
      this.#initialDelay * this.#factor ** (retryNumber - 1),
      this.#maxDelay,
    );
    const random = this.#random();
    const delay = ceiling * Math.max(0, Math.min(1, random));
    const timer = setTimeout(reconnect, delay);
    const abort = () => clearTimeout(timer);

    context.signal.addEventListener("abort", abort, { once: true });

    return () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    };
  }
}
