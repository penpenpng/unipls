import type {
  ReconnectionAttempt,
  ReconnectionContext,
  UniplsReconnectEvent,
} from './reconnector/reconnector.ts';
import type { SessionId } from './types.ts';

/** 1 回の open() 呼び出しに対応するセッションスコープの再接続状態を表します。 */
class UniplsSectionState {
  readonly #id: SessionId;
  readonly #controller = new AbortController();

  get id(): SessionId {
    return this.#id;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  lastError: unknown = undefined;
  readonly attempts: ReconnectionAttempt[] = [];

  constructor(id: SessionId) {
    this.#id = id;
  }

  abort(): void {
    this.#controller.abort();
  }

  onSuccess(): void {
    this.lastError = undefined;
  }

  onFailure(err: unknown): void {
    this.lastError = err;
  }
}

/** セッションに関する状態を一元管理するクラスです。セッションを跨ぐ履歴と、セッションスコープの状態を保持します。 */
export class UniplsSessionManager {
  static #nextId = 1;
  readonly #allAttempts: ReconnectionAttempt[] = [];
  #session = new UniplsSectionState(NaN); // 初期状態（open() 前）

  /** open() 呼び出し時に新しいセッション状態を作成します。 */
  new(): void {
    this.#session = new UniplsSectionState(UniplsSessionManager.#nextId++);
  }

  /** close() 呼び出し時に現在のセッションの AbortSignal を abort します。 */
  abort(): void {
    this.#session.abort();
  }

  /** {@link ReconnectionContext} を構築します。 */
  buildContext(): ReconnectionContext {
    return {
      session: this.#session.id,
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
      attemptedAt: Date.now(),
      error: this.#session.lastError,
    };
    this.#session.attempts.push(attempt);
    this.#allAttempts.push(attempt);
  }

  /** 再接続成功時に呼び出します。 */
  onSuccess(): UniplsReconnectEvent {
    const event: UniplsReconnectEvent = {
      session: this.#session.id,
      sessionAttempts: [...this.#session.attempts],
    };
    this.#session.onSuccess();
    return event;
  }

  /** 再接続失敗時に呼び出します。エラーを記録します。 */
  onFailure(err: unknown): void {
    this.#session.onFailure(err);
  }
}
