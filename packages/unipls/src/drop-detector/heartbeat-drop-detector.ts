import { UniplsTimeoutError } from "../errors.ts";
import type { UniplsMessageFactory } from "../unipls.interface.ts";
import type { DropDetectorContext, UniplsDropDetector } from "./drop-detector";

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
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
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
  setup(ctx: DropDetectorContext<TInput, TOutput>): () => void {
    const abort = new AbortController();

    const loop = async () => {
      while (!abort.signal.aborted) {
        try {
          await sleep(this.#options.interval, abort.signal);
        } catch {
          break;
        }

        try {
          await ctx.request({
            query: this.#options.ping,
            selector: this.#options.pong,
            timeout: this.#options.timeout ?? this.#options.interval,
            signal: abort.signal,
          });
        } catch (err) {
          if (err instanceof UniplsTimeoutError) {
            ctx.drop();
          }
          // timeout は drop として報告し、それ以外の終了理由では監視だけを終了します。
          break;
        }
      }
    };

    void loop();

    return () => abort.abort();
  }
}
