import type { UniplsMessageFactory } from "../unipls.interface.ts";

export interface UniplsDropDetector<TInput = unknown, TOutput = unknown> {
  /** 同じ client に登録する detector 間で一意な診断用の名前です。 */
  readonly name?: string;

  /**
   * プロビジョニング完了後に呼び出されます。接続ごと（再接続を含む）に呼ばれます。
   * 返り値の関数は切断（drop/close）時に呼ばれます。
   */
  setup(ctx: DropDetectorContext<TInput, TOutput>): () => void;
}

export interface DropDetectorContext<TInput = unknown, TOutput = unknown> {
  /** 接続を強制的に drop とみなします。 */
  drop(): void;

  /** メッセージを送信してレスポンスを待ちます。 */
  request(params: DropDetectorRequestParams<TInput, TOutput>): Promise<TOutput>;
}

export interface DropDetectorRequestParams<TInput = unknown, TOutput = unknown> {
  query: UniplsMessageFactory<TInput>;
  selector: (msg: TOutput) => boolean;
  timeout?: number;
  signal?: AbortSignal;
}
