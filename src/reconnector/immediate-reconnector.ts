import type { UniplsReconnector, UniplsReconnectorActions } from "./reconnector";

/** 即時 reconnector の設定です。 */
export interface ImmediateReconnectorOptions {
  /** 初回接続を除く最大再試行回数です。省略時は無制限です。 */
  maxRetries?: number;
}

/** drop を検出すると待機せずに再接続し、任意の再試行上限で終了します。 */
export class ImmediateReconnector implements UniplsReconnector {
  readonly #maxRetries: number;

  constructor(options: ImmediateReconnectorOptions = {}) {
    this.#maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY;
    if (
      options.maxRetries !== undefined &&
      (!Number.isInteger(this.#maxRetries) || this.#maxRetries < 0)
    ) {
      throw new RangeError("maxRetries は0以上の整数で指定してください。");
    }
  }

  /** 再接続操作をただちに実行します。 */
  setup(
    { reconnect, exhaust }: UniplsReconnectorActions,
    context: Parameters<UniplsReconnector["setup"]>[1],
  ) {
    // context.attempt は失敗した接続試行の番号で、初回失敗は1です。
    if (context.attempt - 1 >= this.#maxRetries) {
      exhaust(context.cause);
      return;
    }

    reconnect();
  }
}
