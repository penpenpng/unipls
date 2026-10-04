import { UniplsInvalidUsageError } from "./errors.ts";
import type { UniplsResourceScope } from "./types.ts";

/** 同期処理または PromiseLike として完了する処理です。 */
export type MaybePromise<T> = T | PromiseLike<T>;

/** 所有している resource を解放する処理です。 */
export type Disposer = () => MaybePromise<void>;

/** resource の診断用名称を指定します。 */
export interface ResourceOptions {
  /** 同じ scope 内で一意な診断用名称です。省略した resource の個別識別は保証されません。 */
  readonly name?: string;
}

/** session または connection に所有させる resource を登録します。 */
export interface ResourceScope {
  /** scope が終了すると abort されます。 */
  readonly signal: AbortSignal;
  /** resource の解放処理を登録します。登録と逆順に一度ずつ実行されます。 */
  defer(disposer: Disposer, options?: ResourceOptions): void;
}

/** resource が登録された library 境界です。 */
export type ResourceRegistrationSource = "defer" | "setup-return" | "internal";

interface ResourceEntry {
  readonly disposer: Disposer;
  readonly name?: string;
  readonly source: ResourceRegistrationSource;
}

interface CleanupFailure {
  readonly cause: unknown;
  readonly scope: UniplsResourceScope;
  readonly name?: string;
  readonly source: ResourceRegistrationSource;
}

/** @internal session、connection、setup transaction の resource 所有権を管理します。 */
export class OwnedResourceScope implements ResourceScope {
  readonly #controller = new AbortController();
  readonly #entries: ResourceEntry[] = [];
  readonly #names = new Set<string>();
  readonly #scope: UniplsResourceScope;
  readonly #onCleanupFailure: (failure: CleanupFailure) => void;
  #accepting = true;
  #disposePromise?: Promise<void>;
  #resolveDispose?: () => void;
  #disposed = false;
  #committed = false;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** cleanup がすべて同期的に完了済みの場合に `true` を返します。 */
  get disposed(): boolean {
    return this.#disposed;
  }

  constructor(params: {
    scope: UniplsResourceScope;
    onCleanupFailure: (failure: CleanupFailure) => void;
    parentSignal?: AbortSignal;
  }) {
    this.#scope = params.scope;
    this.#onCleanupFailure = params.onCleanupFailure;

    if (params.parentSignal) {
      const parentSignal = params.parentSignal;

      if (parentSignal.aborted) {
        void this.dispose(parentSignal.reason);
      } else {
        parentSignal.addEventListener(
          "abort",
          () => {
            void this.dispose(parentSignal.reason);
          },
          { once: true },
        );
      }
    }
  }

  defer = (disposer: Disposer, options?: ResourceOptions): void => {
    this.#register(disposer, options, "defer");
  };

  /** setup hook が返した disposer を現在の transaction に登録します。 */
  deferReturned(disposer: Disposer): void {
    this.#register(disposer, undefined, "setup-return");
  }

  /** library が所有する安定した名称の resource を登録します。 */
  deferLibrary(disposer: Disposer, name: string): void {
    this.#register(disposer, { name }, "internal");
  }

  /** 登録を終了し、transaction の cleanup を親 scope に移します。 */
  commitTo(parent: OwnedResourceScope, name: string): void {
    if (this.#committed || !this.#accepting || this.#disposePromise) {
      throw new UniplsInvalidUsageError("resource transaction は既に終了しています。");
    }

    this.#committed = true;
    this.#accepting = false;
    parent.deferLibrary(() => {
      const disposal = this.dispose();

      return this.#disposed ? undefined : disposal;
    }, name);
  }

  /** 新規登録を禁止します。cleanup は所有 scope が終了するまで開始しません。 */
  seal(): void {
    this.#accepting = false;
  }

  /** cleanup を一度だけ開始し、競合する呼び出しへ同じ Promise を返します。 */
  dispose(reason?: unknown): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise;
    }

    this.#accepting = false;
    this.#controller.abort(reason);
    this.#disposePromise = new Promise<void>((resolve) => {
      this.#resolveDispose = resolve;
    });
    this.#continueDisposal();

    return this.#disposePromise;
  }

  #register(
    disposer: Disposer,
    options: ResourceOptions | undefined,
    source: ResourceRegistrationSource,
  ): void {
    if (!this.#accepting) {
      throw new UniplsInvalidUsageError("終了した resource scope には登録できません。");
    }
    if (typeof disposer !== "function") {
      throw new TypeError("defer には disposer 関数を指定してください。");
    }

    const name = options?.name;

    if (name !== undefined) {
      if (this.#names.has(name)) {
        throw new UniplsInvalidUsageError(`resource name は scope 内で一意にしてください: ${name}`);
      }

      this.#names.add(name);
    }

    this.#entries.push({ disposer, ...(name === undefined ? {} : { name }), source });
  }

  #continueDisposal(): void {
    while (this.#entries.length > 0) {
      const entry = this.#entries.pop() as ResourceEntry;
      let result: MaybePromise<void>;

      try {
        result = entry.disposer();
      } catch (cause) {
        this.#reportFailure(entry, cause);
        continue;
      }

      if (isPromiseLike(result)) {
        void Promise.resolve(result).then(
          () => this.#continueDisposal(),
          (cause) => {
            this.#reportFailure(entry, cause);
            this.#continueDisposal();
          },
        );

        return;
      }
    }
    this.#disposed = true;
    this.#resolveDispose?.();
  }

  #reportFailure(entry: ResourceEntry, cause: unknown): void {
    try {
      this.#onCleanupFailure({
        cause,
        scope: this.#scope,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        source: entry.source,
      });
    } catch {
      // 診断処理自体の失敗で残りの cleanup を止めません。
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    (typeof value === "object" && value !== null && "then" in value) ||
    (typeof value === "function" && "then" in value)
  );
}
