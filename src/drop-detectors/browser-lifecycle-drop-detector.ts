import {
  BrowserLifecycleSource,
  type BrowserLifecycleTrigger,
} from "../shared/browser-lifecycle.ts";
import { DropReasons } from "../shared/drop-reasons.ts";
import { UniplsTimeoutError } from "../shared/errors.ts";
import type {
  DropDetectorContext,
  DropDetectorRequestParams,
  UniplsDropDetector,
} from "./drop-detector.ts";

export interface BrowserLifecycleDropDetectorOptions<TInput, TOutput> {
  /** 同じ client の reconnector と共有する source です。 */
  source: BrowserLifecycleSource;
  /** probe ごとに query と対応する selector を生成します。 */
  createProbe: () => Omit<DropDetectorRequestParams<TInput, TOutput>, "signal" | "timeout">;
  /** probe の待機時間です。既定値は 5,000 ms です。 */
  timeout?: number;
  /** 復帰イベントをまとめる時間です。既定値は 100 ms です。 */
  coalesceDelay?: number;
  /** hidden 中の timeout 判定を復帰後まで保留します。既定値は true です。 */
  deferWhileHidden?: boolean;
  name?: string;
}

/** lifecycle の変化を契機に現在の接続で一往復の疎通確認をします。 */
export class BrowserLifecycleDropDetector<TInput, TOutput> implements UniplsDropDetector<
  TInput,
  TOutput
> {
  readonly name?: string;
  readonly #options: BrowserLifecycleDropDetectorOptions<TInput, TOutput>;

  constructor(options: BrowserLifecycleDropDetectorOptions<TInput, TOutput>) {
    this.#options = { ...options };
    this.name = options.name;
    for (const value of [options.timeout ?? 5_000, options.coalesceDelay ?? 100]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError("Probe timing must be finite and non-negative.");
      }
    }
  }

  setup(ctx: DropDetectorContext<TInput, TOutput>): void {
    const options = this.#options;
    if (ctx.sessionSignal) {
      options.source.retainSession(ctx.sessionSignal);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    let generation = 0;
    const cancel = () => {
      generation++;
      clearTimeout(timer);
      timer = undefined;
      active?.abort();
      active = undefined;
    };
    const schedule = (trigger: BrowserLifecycleTrigger, recovery: boolean) => {
      if (ctx.signal.aborted || options.source.snapshot.suspended) {
        return;
      }
      if (active || timer !== undefined) {
        if (!recovery) {
          return;
        }
        // 復帰前の probe だけを破棄し、同じ復帰のイベント群はまとめます。
        if (timer !== undefined) {
          return;
        }
        cancel();
      }
      const epoch = generation;
      timer = setTimeout(() => {
        timer = undefined;
        if (ctx.signal.aborted || options.source.snapshot.suspended) {
          return;
        }
        const controller = new AbortController();
        active = controller;
        ctx.run(async (signal) => {
          try {
            await ctx.request({
              ...options.createProbe(),
              timeout: options.timeout ?? 5_000,
              signal: AbortSignal.any([signal, controller.signal]),
            });
          } catch (cause) {
            if (signal.aborted || controller.signal.aborted || epoch !== generation) {
              return;
            }
            if (!(cause instanceof UniplsTimeoutError)) {
              throw cause;
            }
            const state = options.source.snapshot;
            if (state.suspended || ((options.deferWhileHidden ?? true) && state.hidden)) {
              return;
            }
            ctx.drop({
              reason: DropReasons.BROWSER_LIFECYCLE_PROBE_TIMEOUT,
              metadata: { trigger },
            });
          } finally {
            if (active === controller) {
              active = undefined;
            }
          }
        });
      }, options.coalesceDelay ?? 100);
    };
    const unsubscribe = options.source.subscribe(
      ctx.guard((event) => {
        if (event.trigger === "freeze" || event.trigger === "pagehide") {
          cancel();
          return;
        }
        schedule(event.trigger, event.recovery);
      }),
    );
    ctx.signal.addEventListener("abort", cancel, { once: true });
    ctx.defer(
      () => {
        cancel();
        unsubscribe();
        ctx.signal.removeEventListener("abort", cancel);
      },
      { name: "browser-lifecycle-probes" },
    );
  }
}
