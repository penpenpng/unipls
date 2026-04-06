import type {
  DropDetectorContext,
  UniplsDropDetector,
} from '../../drop-detector/index.ts';
import { AwaitableQueue } from './awaitable-queue';

/**
 * テスト用の手動 {@link UniplsDropDetector} です。
 * `setups` キューから取得した {@link DropDetectorContext} を使って任意のタイミングで drop を発生させられます。
 */
export class TestDropDetector<TInput = unknown, TOutput = unknown>
  implements UniplsDropDetector<TInput, TOutput>
{
  readonly contexts = new AwaitableQueue<
    DropDetectorContext<TInput, TOutput>
  >();

  private ctx?: DropDetectorContext<TInput, TOutput>;
  setupCount = 0;
  cleanupCount = 0;

  setup(ctx: DropDetectorContext<TInput, TOutput>): () => void {
    this.ctx = ctx;
    this.contexts.enqueue(ctx);

    this.setupCount++;

    return () => {
      this.cleanupCount++;
    };
  }

  drop() {
    this.ctx?.drop();
  }

  dequeueContext() {
    return this.contexts.dequeue();
  }
}
