import type { UniplsMessageFactory } from "../unipls.interface.ts";

/** ready な接続を監視し、利用者定義の条件で drop を報告します。 */
export interface UniplsDropDetector<TInput = unknown, TOutput = unknown> {
  /** 同じ client に登録する detector 間で一意な診断用の名前です。 */
  readonly name?: string;

  /**
   * 接続が ready になる直前に接続ごとに呼ばれます。
   * 返した関数は、その接続が drop または close されたときに1回呼ばれます。
   */
  setup(ctx: DropDetectorContext<TInput, TOutput>): () => void;
}

/** detector が現在の接続を監視するために使う操作です。 */
export interface DropDetectorContext<TInput = unknown, TOutput = unknown> {
  /** 接続を強制的に drop とみなします。 */
  drop(): void;

  /** メッセージを送信してレスポンスを待ちます。 */
  request(params: DropDetectorRequestParams<TInput, TOutput>): Promise<TOutput>;
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
