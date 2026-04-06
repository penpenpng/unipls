import type { SessionId } from "../types.ts";

export interface UniplsReconnector {
  setup(actions: UniplsReconnectorActions, ctx: ReconnectionContext): void | (() => void);
}

export interface UniplsReconnectorActions {
  reconnect(): void;
  cancel(): void;
}

export interface ReconnectionContext {
  /** 現在のセッションを表します。 */
  session: SessionId;

  /** この再接続よりも前に試行した再接続の中で最も新しい試行を行った時刻を表します。 */
  lastAttemptedAt?: number;

  /** この再接続を引き起こしたエラーがある場合、それを表します。 */
  error?: unknown;

  /** 現在のセッションで行われた再接続のリストを表します。この値は変更可能です。 */
  sessionAttempts: ReconnectionAttempt[];

  /** すべてのセッションで行われた再接続のリストを表します。この値は変更可能です。 */
  allAttempts: ReconnectionAttempt[];

  /** {@link Unipls.close|unipls.close()} が呼ばれたときに abort される {@link AbortSignal} です。再接続待機の中断に利用できます。 */
  signal: AbortSignal;
}

export interface ReconnectionAttempt {
  session: SessionId;
  attemptedAt: number;
  error?: unknown;
}

export interface UniplsReconnectEvent {
  /** 再接続後のセッションを表します。 */
  session: SessionId;

  /** このセッションで行われた再接続の試行履歴を表します。 */
  sessionAttempts: readonly ReconnectionAttempt[];
}
