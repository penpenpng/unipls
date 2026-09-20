import type { DropDetectorContext, UniplsDropDetector } from "./drop-detector";

/** {@link UniplsDropDetector} のライフサイクルを管理するクラスです。 */
export class DropDetectorManager<TInput, TOutput> {
  #detectors: readonly UniplsDropDetector<TInput, TOutput>[];
  #disposes: (() => void)[] = [];
  #transportEpochId?: number;

  constructor(detectors: readonly UniplsDropDetector<TInput, TOutput>[]) {
    this.#detectors = detectors;
  }

  /** プロビジョニング完了後に呼び出します。各 detector の setup() を実行します。 */
  start(transportEpochId: number, ctx: DropDetectorContext<TInput, TOutput>): void {
    this.stop();
    this.#transportEpochId = transportEpochId;
    this.#disposes = this.#detectors.map((d) => d.setup(ctx));
  }

  /** 切断または close() 時に呼び出します。各 detector の dispose 関数を実行します。 */
  stop(transportEpochId?: number): void {
    if (transportEpochId !== undefined && transportEpochId !== this.#transportEpochId) {
      return;
    }
    for (const dispose of this.#disposes) {
      dispose();
    }
    this.#disposes = [];
    this.#transportEpochId = undefined;
  }
}
