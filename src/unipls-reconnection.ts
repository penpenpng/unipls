import type { SessionId } from './types.ts';
import type {
  ReconnectionAttempt,
  ReconnectionContext,
  UniplsReconnectEvent,
} from './unipls-reconnector.ts';

/** 1 回の open() 呼び出しに対応するセッションスコープの再接続状態を表します。 */
class ReconnectionSessionState {
  readonly #id: SessionId;
  readonly #controller = new AbortController();

  get id(): SessionId {
    return this.#id;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  streak = 0;
  lastError: unknown = undefined;
  readonly attempts: ReconnectionAttempt[] = [];

  constructor(id: SessionId) {
    this.#id = id;
  }

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
  static #nextId = 1;
  readonly #allAttempts: ReconnectionAttempt[] = [];
  #session = new ReconnectionSessionState(NaN); // 初期状態（open() 前）

  /** open() 呼び出し時に新しいセッション状態を作成します。 */
  new(): void {
    this.#session = new ReconnectionSessionState(UniplsSessionManager.#nextId++);
  }

  /** close() 呼び出し時に現在のセッションの AbortSignal を abort します。 */
  abort(): void {
    this.#session.abort();
  }

  /** {@link ReconnectionContext} を構築します。 */
  buildContext(): ReconnectionContext {
    return {
      session: this.#session.id,
      streak: this.#session.streak,
      lastAttemptedAt: this.#session.attempts.at(-1)?.attemptedAt,
      error: this.#session.lastError,
      sessionAttempts: this.#session.attempts,
      allAttempts: this.#allAttempts,
      signal: this.#session.signal,
    };
  }

  /** 再接続を試行したことを記録します。 */
  recordAttempt(): void {
    const attempt: ReconnectionAttempt = {
      session: this.#session.id,
      streak: this.#session.streak,
      attemptedAt: Date.now(),
      error: this.#session.lastError,
    };
    this.#session.attempts.push(attempt);
    this.#allAttempts.push(attempt);
  }

  /** 再接続成功時に呼び出します。リセット前の状態を DTO として返し、streak をリセットします。 */
  onSuccess(): UniplsReconnectEvent {
    const event: UniplsReconnectEvent = {
      session: this.#session.id,
      streak: this.#session.streak,
      sessionAttempts: [...this.#session.attempts],
    };
    this.#session.onSuccess();
    return event;
  }

  /** 再接続失敗時に呼び出します。streak をインクリメントし、エラーを記録します。 */
  onFailure(err: unknown): void {
    this.#session.onFailure(err);
  }
}
