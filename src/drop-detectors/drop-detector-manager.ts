import { OwnedResourceScope } from "../shared/resource-scope.ts";
import type { DropDetectorIdentity } from "../shared/types.ts";
import type { DropDetectorContext, UniplsDropDetector } from "./drop-detector.ts";

interface DetectorRegistration<TInput, TOutput> {
  readonly detector: UniplsDropDetector<TInput, TOutput>;
  readonly identity: DropDetectorIdentity;
}

/** {@link UniplsDropDetector} の接続単位の setup と resource 所有権を管理します。 */
export class DropDetectorManager<TInput, TOutput> {
  readonly #registrations: readonly DetectorRegistration<TInput, TOutput>[];

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

  /** detector setup を connection setup transaction の一部として順番に実行します。 */
  async setup(params: {
    transaction: OwnedResourceScope;
    createScope: (identity: DropDetectorIdentity) => OwnedResourceScope;
    createContext: (
      identity: DropDetectorIdentity,
      scope: OwnedResourceScope,
      fail: (boundary: "guard" | "run", cause: unknown) => void,
    ) => DropDetectorContext<TInput, TOutput>;
    onRuntimeFailure: (
      identity: DropDetectorIdentity,
      boundary: "guard" | "run",
      cause: unknown,
    ) => void;
  }): Promise<void> {
    for (const { detector, identity } of this.#registrations) {
      const scope = params.createScope(identity);
      let failed = false;
      const fail = (boundary: "guard" | "run", cause: unknown) => {
        if (failed || scope.signal.aborted) {
          return;
        }

        failed = true;

        params.onRuntimeFailure(identity, boundary, cause);
        void scope.dispose(cause);
      };
      const context = params.createContext(identity, scope, fail);
      let returned: Awaited<ReturnType<UniplsDropDetector<TInput, TOutput>["setup"]>>;

      try {
        returned = await detector.setup(context);
      } catch (cause) {
        await scope.dispose(cause);
        throw cause;
      }
      try {
        if (returned !== undefined) {
          scope.deferReturned(returned);
        }

        scope.commitTo(params.transaction, `drop-detector:${identity.registrationIndex}`);
      } catch (cause) {
        await scope.dispose(cause);
        throw cause;
      }
    }
  }
}
