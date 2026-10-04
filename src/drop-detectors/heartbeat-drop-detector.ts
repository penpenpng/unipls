import type { UniplsMessageFactory } from "../client/unipls.interface.ts";
import { DropReasons } from "../shared/drop-reasons.ts";
import { UniplsTimeoutError } from "../shared/errors.ts";
import type { DropDetectorContext, UniplsDropDetector } from "./drop-detector.ts";

/** heartbeat の送信間隔、応答条件、待機時間を指定します。 */
export interface HeartbeatOptions<TInput, TOutput> {
  /** ping の送信間隔をミリ秒で指定します。 */
  interval: number;

  /** pong を待つ最大時間です。省略時は `interval` と同じ値を使います。 */
  timeout?: number;

  /** ping として送信する値、または送信時に値を生成する関数です。 */
  ping: UniplsMessageFactory<TInput>;
  /** pong とみなすメッセージを判定します。 */
  pong: (msg: TOutput) => boolean;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);

      return;
    }

    const finish = (callback: () => void) => {
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const onAbort = () =>
      finish(() => {
        clearTimeout(timer);
        reject(signal.reason);
      });

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 定期的な ping に応答がない接続を drop として報告します。 */
export class HeartbeatDropDetector<TInput, TOutput> implements UniplsDropDetector<TInput, TOutput> {
  #options: HeartbeatOptions<TInput, TOutput>;

  /** heartbeat の契約を指定して detector を作成します。 */
  constructor(options: HeartbeatOptions<TInput, TOutput>) {
    this.#options = options;
  }

  /** 現在の接続に対する heartbeat 監視を開始します。 */
  setup(ctx: DropDetectorContext<TInput, TOutput>): void {
    const loop = async (signal: AbortSignal) => {
      while (!signal.aborted) {
        try {
          await sleep(this.#options.interval, signal);
        } catch {
          break;
        }

        try {
          await ctx.request({
            query: this.#options.ping,
            selector: this.#options.pong,
            timeout: this.#options.timeout ?? this.#options.interval,
            signal,
          });
        } catch (err) {
          if (signal.aborted) {
            break;
          }
          if (err instanceof UniplsTimeoutError) {
            ctx.drop({ reason: DropReasons.HEARTBEAT_RESPONSE_TIMEOUT });
            break;
          }

          // 接続終了以外の失敗はrun()の監督境界へ渡し、detector failureとして通知します。
          throw err;
        }
      }
    };

    ctx.run(loop);
  }
}
