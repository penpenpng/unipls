import type { UniplsMessageFactory } from "../unipls.interface.ts";
import type { Disposer, MaybePromise, ResourceScope } from "../resource-scope.ts";
import type { DropDetectorIdentity } from "../types.ts";

/** ready な接続を監視し、利用者定義の条件で drop を報告します。 */
export interface UniplsDropDetector<TInput = unknown, TOutput = unknown> {
  /** 同じ client に登録する detector 間で一意な診断用の名前です。 */
  readonly name?: string;

  /**
   * 接続が ready になる直前に接続ごとに呼ばれます。
   * 返した disposer と `ctx.defer()` へ登録した resource は接続終了時に解放されます。
   */
  setup(ctx: DropDetectorContext<TInput, TOutput>): MaybePromise<void | Disposer>;
}

/** detector が現在の接続を監視するために使う操作です。 */
export interface DropDetectorContext<TInput = unknown, TOutput = unknown> extends ResourceScope {
  /** この detector を識別する不変な情報です。 */
  readonly detector: DropDetectorIdentity;

  /** 接続を強制的に drop とみなします。 */
  drop(): void;

  /** メッセージを送信してレスポンスを待ちます。 */
  request(params: DropDetectorRequestParams<TInput, TOutput>): Promise<TOutput>;

  /** host event callback の同期throwと非同期rejectを当該detectorへ隔離します。 */
  guard<TArgs extends readonly unknown[]>(
    callback: (...args: TArgs) => MaybePromise<void>,
  ): (...args: TArgs) => void;

  /** background taskを開始し、その同期throwと非同期rejectを当該detectorへ隔離します。 */
  run(task: () => MaybePromise<void>): void;
}

/** detector が接続の健全性を問い合わせるための request を指定します。 */
export interface DropDetectorRequestParams<TInput = unknown, TOutput = unknown> {
  /** 送信する値、または送信時に値を生成する関数です。 */
  query: UniplsMessageFactory<TInput>;
  /** 応答とみなすメッセージを判定します。 */
  selector: (msg: TOutput) => boolean;
  /** 応答を待つ最大時間をミリ秒で指定します。 */
  timeout?: number;
  /** request を中断する signal です。 */
  signal?: AbortSignal;
}
