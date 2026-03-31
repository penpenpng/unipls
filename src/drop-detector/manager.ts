import type { DropDetector, DropDetectorContext } from './index.ts';

/** {@link DropDetector} のライフサイクルを管理するクラスです。 */
export class DropDetectorManager<TInput, TOutput> {
  #detectors: readonly DropDetector<TInput, TOutput>[];
  #disposes: (() => void)[] = [];

  constructor(detectors: readonly DropDetector<TInput, TOutput>[]) {
    this.#detectors = detectors;
  }

  /** プロビジョニング完了後に呼び出します。各 detector の setup() を実行します。 */
  start(ctx: DropDetectorContext<TInput, TOutput>): void {
    this.#disposes = this.#detectors.map((d) => d.setup(ctx));
  }

  /** 切断または close() 時に呼び出します。各 detector の dispose 関数を実行します。 */
  stop(): void {
    for (const dispose of this.#disposes) {
      dispose();
    }
    this.#disposes = [];
  }
}
