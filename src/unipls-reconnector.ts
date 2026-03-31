import type { SessionId } from './types.ts';

export interface ReconnectionContext {
  /** 現在のセッションを表します。 */
  session: SessionId;

  /** open イベントを挟まずに何回連続で再接続を試行しているかを表します。 */
  streak: number;

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
  streak: number;
  attemptedAt: number;
  error?: unknown;
}

export interface UniplsReconnector {
  reconnect(ctx: ReconnectionContext): boolean | Promise<boolean>;
}
