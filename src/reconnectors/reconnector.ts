import type {
  ConnectionAttemptOrigin,
  ConnectionAttemptSnapshot,
  ConnectionAttemptStage,
  ReconnectionEngineOutcome,
  SessionId,
  UniplsDrop,
} from "../shared/types.ts";

/** drop 後に再接続を試みる時期と終了条件を決定します。 */
export interface UniplsReconnector {
  /** 回復操作と失敗した試行の情報を受け取り、必要なら後始末の関数を返します。 */
  setup(
    actions: UniplsReconnectorActions,
    ctx: ReconnectionContext,
  ): void | (() => void) | PromiseLike<void | (() => void)>;
}

/** reconnector が1回の回復判断で選択できる操作です。最初に呼んだ操作だけが有効です。 */
export interface UniplsReconnectorActions {
  /** 新しい WebSocket 接続を1回試みます。 */
  reconnect(): void;
  /** 回復を利用者判断で中止し、論理セッションを終了します。 */
  cancel(): void;
  /** 再試行の余地がないものとして論理セッションを終了します。 */
  exhaust(cause?: unknown): void;
}

/** reconnector が回復方針を決めるために参照できる情報です。 */
export interface ReconnectionContext {
  /** 現在の論理セッションです。 */
  readonly session: SessionId;

  /** 判断対象が初回接続と接続回復のどちらに属するかを表します。 */
  readonly origin: ConnectionAttemptOrigin;

  /** 直前の試行が失敗した段階です。 */
  readonly stage: ConnectionAttemptStage;

  /** 判断の対象となる、回復サイクル内の試行番号です。 */
  readonly attempt: number;

  /** 判断の起点となった元の例外または値です。 */
  readonly cause: unknown;

  /** 現在の論理セッションで完了した接続試行の不変な履歴です。 */
  readonly attempts: readonly ConnectionAttemptSnapshot[];

  /** ready だった接続を失った回復サイクルの起点です。 */
  readonly drop?: UniplsDrop;

  /** 論理セッションが終了すると abort される signal です。待機処理の中断に利用できます。 */
  readonly signal: AbortSignal;
}

/** 接続回復が成功したことを通知する情報です。 */
export interface UniplsReconnectEvent {
  /** 回復した論理セッションです。 */
  readonly session: SessionId;

  /** 回復エンジンが確定した結果です。 */
  readonly outcome: Extract<ReconnectionEngineOutcome, "succeeded">;

  /** この論理セッションで完了した接続試行の履歴です。 */
  readonly attempts: readonly ConnectionAttemptSnapshot[];
}
