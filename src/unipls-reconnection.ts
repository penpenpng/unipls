import type { SessionId } from './types.ts';
import type {
  ReconnectionAttempt,
  ReconnectionContext,
} from './unipls-reconnector.ts';

/** 1 回の open() 呼び出しに対応するセッションスコープの再接続状態を表します。 */
class ReconnectionSessionState {
  readonly #controller = new AbortController();

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  streak = 0;
  lastError: unknown = undefined;
  readonly attempts: ReconnectionAttempt[] = [];

  abort(): void {
    this.#controller.abort();
  }

  onSuccess(): void {
    this.streak = 0;
    this.lastError = undefined;
  }

  onFailure(err: unknown): void {
    this.streak++;
    this.lastError = err;
  }
}

/** セッションに関する状態を一元管理するクラスです。セッションを跨ぐ履歴と、セッションスコープの状態を保持します。 */
export class UniplsSessionManager {
  readonly #allAttempts: ReconnectionAttempt[] = [];
  #session = new ReconnectionSessionState();

  /** open() 呼び出し時に新しいセッション状態を作成します。 */
  new(): void {
    this.#session = new ReconnectionSessionState();
  }

  /** close() 呼び出し時に現在のセッションの AbortSignal を abort します。 */
  abort(): void {
    this.#session.abort();
  }

  /** {@link ReconnectionContext} を構築します。 */
  buildContext(sessionId: SessionId): ReconnectionContext {
    return {
      session: sessionId,
      streak: this.#session.streak,
      lastAttemptedAt: this.#session.attempts.at(-1)?.attemptedAt,
      error: this.#session.lastError,
      sessionAttempts: this.#session.attempts,
      allAttempts: this.#allAttempts,
      signal: this.#session.signal,
    };
  }

  /** 再接続を試行したことを記録します。 */
  recordAttempt(sessionId: SessionId): void {
    const attempt: ReconnectionAttempt = {
      session: sessionId,
      streak: this.#session.streak,
      attemptedAt: Date.now(),
      error: this.#session.lastError,
    };
    this.#session.attempts.push(attempt);
    this.#allAttempts.push(attempt);
  }

  /** 再接続成功時に呼び出します。streak をリセットします。 */
  onSuccess(): void {
    this.#session.onSuccess();
  }

  /** 再接続失敗時に呼び出します。streak をインクリメントし、エラーを記録します。 */
  onFailure(err: unknown): void {
    this.#session.onFailure(err);
  }
}
