import type { DropDetectorContext, UniplsDropDetector } from "./drop-detector";
import type { DropDetectorIdentity } from "../types.ts";

interface DetectorRegistration<TInput, TOutput> {
  readonly detector: UniplsDropDetector<TInput, TOutput>;
  readonly identity: DropDetectorIdentity;
}

/** {@link UniplsDropDetector} のライフサイクルを管理するクラスです。 */
export class DropDetectorManager<TInput, TOutput> {
  #registrations: readonly DetectorRegistration<TInput, TOutput>[];
  #disposes: (() => void)[] = [];
  #transportEpochId?: number;

  constructor(detectors: readonly UniplsDropDetector<TInput, TOutput>[]) {
    const names = new Set<string>();
    this.#registrations = detectors.map((detector, registrationIndex) => {
      if (detector.name !== undefined) {
        if (names.has(detector.name)) {
          throw new TypeError(`Drop detector name must be unique: ${detector.name}`);
        }
        names.add(detector.name);
      }
      return Object.freeze({
        detector,
        identity: Object.freeze({
          registrationIndex,
          ...(detector.name === undefined ? {} : { name: detector.name }),
        }),
      });
    });
  }

  /** 接続が ready になる直前に各 detector の `setup()` を実行します。 */
  start(
    transportEpochId: number,
    createContext: (identity: DropDetectorIdentity) => DropDetectorContext<TInput, TOutput>,
  ): void {
    this.stop();
    this.#transportEpochId = transportEpochId;
    this.#disposes = this.#registrations.map(({ detector, identity }) =>
      detector.setup(createContext(identity)),
    );
  }

  /** 接続の drop または close 時に各 detector の後始末を実行します。 */
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
