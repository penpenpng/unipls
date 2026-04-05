import { UniplsTimeoutError } from '../errors.ts';
import type { UniplsMessageFactory } from '../unipls.interface.ts';
import type { DropDetectorContext, UniplsDropDetector } from './drop-detector';

export interface HeartbeatOptions<TInput, TOutput> {
  /** ping 送信間隔 (ms) */
  interval: number;

  /** pong 待機タイムアウト (ms)。省略時は interval と同値 */
  timeout?: number;

  ping: UniplsMessageFactory<TInput>;
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
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class HeartbeatDropDetector<TInput, TOutput>
  implements UniplsDropDetector<TInput, TOutput>
{
  #options: HeartbeatOptions<TInput, TOutput>;

  constructor(options: HeartbeatOptions<TInput, TOutput>) {
    this.#options = options;
  }

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
          // UniplsDroppedError / UniplsClosedError / AbortError → loop 終了
          break;
        }
      }
    };

    void loop();

    return () => abort.abort();
  }
}
