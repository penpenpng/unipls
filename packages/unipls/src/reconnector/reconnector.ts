import type { SessionId, UniplsDrop } from "../types.ts";

/** drop 後に再接続を試みる時期と終了条件を決定します。 */
export interface UniplsReconnector {
  /** 回復操作と現在のセッション情報を受け取り、必要なら後始末の関数を返します。 */
  setup(actions: UniplsReconnectorActions, ctx: ReconnectionContext): void | (() => void);
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
  session: SessionId;

  /** ready だった接続を失った起点となる drop です。 */
  drop?: UniplsDrop;

  /** 直前の再接続試行を開始した Unix epoch ミリ秒です。 */
  lastAttemptedAt?: number;

  /** 直前の再接続試行が失敗した場合の原因です。 */
  error?: unknown;

  /** 現在の論理セッションで行われた再接続試行の履歴です。 */
  sessionAttempts: ReconnectionAttempt[];

  /** この client が行ったすべての再接続試行の履歴です。 */
  allAttempts: ReconnectionAttempt[];

  /** 論理セッションが終了すると abort される signal です。待機処理の中断に利用できます。 */
  signal: AbortSignal;
}

/** 再接続を開始した時点の記録です。 */
export interface ReconnectionAttempt {
  /** 試行が属する論理セッションです。 */
  session: SessionId;
  /** 試行を開始した Unix epoch ミリ秒です。 */
  attemptedAt: number;
  /** 直前の試行が失敗していた場合の原因です。 */
  error?: unknown;
}

/** 接続回復が成功したことを通知する情報です。 */
export interface UniplsReconnectEvent {
  /** 回復した論理セッションです。 */
  session: SessionId;

  /** この論理セッションで行われた再接続試行の履歴です。 */
  sessionAttempts: readonly ReconnectionAttempt[];
}
