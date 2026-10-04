import { BrowserLifecycleSource } from "../shared/browser-lifecycle.ts";
import { isBrowserLifecycleDrop } from "../shared/drop-reasons.ts";
import type {
  ReconnectionContext,
  UniplsReconnector,
  UniplsReconnectorActions,
} from "./reconnector.ts";

export interface BrowserLifecycleReconnectorOptions {
  /** 同じ client の detector と共有する source です。 */
  source: BrowserLifecycleSource;
  /** lifecycle 以外の原因と初回接続失敗に適用する戦略です。 */
  defaultReconnector: UniplsReconnector;
  /** 全戦略を通じた回復 cycle ごとの最大再試行回数です。省略時は無制限です。 */
  maxRetries?: number;
  /** 復帰イベントをまとめる時間です。既定値は 100 ms です。 */
  coalesceDelay?: number;
}

/** drop の理由と現在の browser 状態から、イベント待ちと指定された戦略を選択します。 */
export class BrowserLifecycleReconnector implements UniplsReconnector {
  readonly #source: BrowserLifecycleSource;
  readonly #defaultReconnector: UniplsReconnector;
  readonly #maxRetries: number;
  readonly #delay: number;
  readonly #bootstrapped = new WeakSet<object>();
  readonly #retries = new WeakMap<object, number>();

  constructor(options: BrowserLifecycleReconnectorOptions) {
    this.#source = options.source;
    this.#defaultReconnector = options.defaultReconnector;
    this.#maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY;
    this.#delay = options.coalesceDelay ?? 100;
    if (!Number.isFinite(this.#delay) || this.#delay < 0) {
      throw new RangeError("coalesceDelay must be finite and non-negative.");
    }
    if (
      options.maxRetries !== undefined &&
      (!Number.isInteger(this.#maxRetries) || this.#maxRetries < 0)
    ) {
      throw new RangeError("maxRetries must be a non-negative integer.");
    }
  }

  setup(
    actions: UniplsReconnectorActions,
    ctx: ReconnectionContext,
  ): ReturnType<UniplsReconnector["setup"]> {
    if (ctx.signal.aborted) {
      return;
    }
    const cycle = ctx.origin === "initial" ? ctx.signal : (ctx.drop ?? ctx.signal);
    const retries = this.#retries.get(cycle) ?? 0;
    if (retries >= this.#maxRetries) {
      actions.exhaust(ctx.cause);
      return;
    }
    const source = this.#source;
    source.retainSession(ctx.signal);
    const lifecycle = ctx.origin === "recovery" && isBrowserLifecycleDrop(ctx.drop);
    const first = !this.#bootstrapped.has(cycle);
    this.#bootstrapped.add(cycle);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delegateRun: { active: boolean; disposer?: () => void } | undefined;
    const stopDelegate = () => {
      const run = delegateRun;
      delegateRun = undefined;
      if (!run) {
        return;
      }
      run.active = false;
      const disposer = run.disposer;
      run.disposer = undefined;
      disposeDelegate(disposer);
    };
    let unsubscribe: (() => void) | undefined;
    const eligible = () => {
      const state = source.snapshot;
      return !state.suspended && !state.offline;
    };
    const clearWaiting = () => {
      clearTimeout(timer);
      timer = undefined;
      stopDelegate();
    };
    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearWaiting();
      unsubscribe?.();
      ctx.signal.removeEventListener("abort", cleanup);
    };
    const reconnect = () => {
      if (disposed || ctx.signal.aborted || !eligible()) {
        return;
      }
      this.#retries.set(cycle, retries + 1);
      cleanup();
      actions.reconnect();
    };
    const onRecovery = () => {
      if (!eligible() || disposed || timer !== undefined) {
        return;
      }
      clearWaiting();
      timer = setTimeout(reconnect, this.#delay);
    };
    unsubscribe = source.subscribe((event) => {
      if (!eligible()) {
        clearWaiting();
      } else if (event.recovery) {
        onRecovery();
      }
    });
    ctx.signal.addEventListener("abort", cleanup, { once: true });
    if (eligible()) {
      if (lifecycle) {
        // 過去に発生した復帰イベントを待ち直さないよう、cycle ごとに一度試します。
        if (first) {
          onRecovery();
        }
      } else {
        const run: { active: boolean; disposer?: () => void } = { active: true };
        delegateRun = run;
        const select = (action: () => void) => {
          if (!run.active || disposed || ctx.signal.aborted) {
            return;
          }
          cleanup();
          action();
        };
        const register = (disposer: void | (() => void)) => {
          if (run.active && !disposed) {
            run.disposer = disposer ?? undefined;
          } else {
            disposeDelegate(disposer);
          }
          return cleanup;
        };
        let result: ReturnType<UniplsReconnector["setup"]>;
        try {
          result = this.#defaultReconnector.setup(
            {
              reconnect: () => {
                if (run.active) {
                  reconnect();
                }
              },
              cancel: () => select(actions.cancel),
              exhaust: (cause) => select(() => actions.exhaust(cause)),
            },
            ctx,
          );
        } catch (cause) {
          cleanup();
          throw cause;
        }
        if (result !== undefined && typeof result !== "function") {
          return Promise.resolve(result).then(register, (cause) => {
            if (run.active && !disposed) {
              cleanup();
              throw cause;
            }
            return cleanup;
          });
        }
        register(result);
      }
    }
    return cleanup;
  }
}

function disposeDelegate(disposer: void | (() => void)): void {
  try {
    disposer?.();
  } catch {
    // engine の policy cleanup と同じく、cleanup の失敗で回復判断を妨げません。
  }
}
