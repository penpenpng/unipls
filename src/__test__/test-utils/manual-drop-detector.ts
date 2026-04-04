import type {
  DropDetector,
  DropDetectorContext,
} from '../../drop-detector/index.ts';
import { AwaitableQueue } from './awaitable-queue.ts';

/**
 * テスト用の手動 {@link DropDetector} です。
 * `setups` キューから取得した {@link DropDetectorContext} を使って任意のタイミングで drop を発生させられます。
 */
export class ManualDropDetector<TInput = unknown, TOutput = unknown>
  implements DropDetector<TInput, TOutput>
{
  /** setup() が呼ばれるたびにコンテキストがエンキューされます。 */
  readonly setups = new AwaitableQueue<DropDetectorContext<TInput, TOutput>>();

  /** dispose 関数が呼ばれるたびにエンキューされます。 */
  readonly disposes = new AwaitableQueue<void>();

  setup(ctx: DropDetectorContext<TInput, TOutput>): () => void {
    this.setups.enqueue(ctx);
    return () => {
      this.disposes.enqueue();
    };
  }
}
