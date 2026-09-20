import type {
  ConnectionAttemptSnapshot,
  ConnectionAttemptStage,
  UniplsDrop,
  UniplsDroppedErrorOutcome,
  UniplsOpenErrorOutcome,
} from "./types.ts";

/** Unipls の公開 API が通知するエラーの基底クラスです。 */
export abstract class UniplsError extends Error {}

/** 公開 API が現在の lifecycle では受け付けられない方法で呼ばれたことを表します。 */
export class UniplsInvalidUsageError extends UniplsError {
  override readonly name = "UniplsInvalidUsageError";

  constructor(message: string) {
    super(message);
  }
}

/** 論理セッションが ready になる前に接続試行が終了したことを表します。 */
export class UniplsOpenError extends UniplsError {
  override readonly name = "UniplsOpenError";
  /** `open()` が終了した理由です。 */
  readonly outcome: UniplsOpenErrorOutcome;
  /** 最後の接続試行が失敗した段階です。 */
  readonly stage?: ConnectionAttemptStage;
  /** この論理セッションで完了した接続試行の履歴です。 */
  readonly attempts: readonly ConnectionAttemptSnapshot[];
  /** 接続喪失が失敗の起点だった場合の drop です。 */
  readonly drop?: UniplsDrop;
  /** 失敗の起点となった元の例外または値です。 */
  override readonly cause: unknown;

  constructor({
    outcome,
    stage,
    attempts,
    cause,
    drop,
  }: {
    outcome: UniplsOpenErrorOutcome;
    stage?: ConnectionAttemptStage;
    attempts: readonly ConnectionAttemptSnapshot[];
    cause: unknown;
    drop?: UniplsDrop;
  }) {
    super("The logical session could not become ready.", { cause });
    this.outcome = outcome;
    this.stage = stage;
    this.attempts = attempts;
    this.cause = cause;
    this.drop = drop;
  }
}

/** 利用者が終了した論理セッションに対して操作を継続できないことを表します。 */
export class UniplsClosedError extends UniplsError {
  constructor() {
    super("UniplsClosedError: The WebSocket was disconnected.");
  }
}

/** drop 後に操作または回復を継続できなかったことを表します。 */
export class UniplsDroppedError extends UniplsError {
  override readonly name = "UniplsDroppedError";
  /** 操作または回復が終了した理由です。 */
  readonly outcome: UniplsDroppedErrorOutcome;
  /** 接続喪失を表す canonical drop です。 */
  readonly drop: UniplsDrop;
  /** この論理セッションで完了した接続試行の履歴です。 */
  readonly attempts: readonly ConnectionAttemptSnapshot[];
  /** 終了に関連する元の例外または値です。 */
  override readonly cause: unknown;

  constructor({
    outcome,
    drop,
    attempts,
    cause,
  }: {
    outcome: UniplsDroppedErrorOutcome;
    drop: UniplsDrop;
    attempts: readonly ConnectionAttemptSnapshot[];
    cause?: unknown;
  }) {
    super("The logical session could not remain ready.", { cause });
    this.outcome = outcome;
    this.drop = drop;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/** 指定された待機時間内に操作が完了しなかったことを表します。 */
export class UniplsTimeoutError extends UniplsError {
  override readonly name = "UniplsTimeoutError";

  constructor() {
    super("The operation timed out.");
  }
}

/** stream の未処理メッセージが指定された buffer capacity を超えたことを表します。 */
export class UniplsBufferOverflowError extends UniplsError {
  override readonly name = "UniplsBufferOverflowError";

  constructor() {
    super("The stream buffer capacity was exceeded.");
  }
}

/** active な論理セッションがある状態で `open()` が再度呼ばれたことを表します。 */
export class UniplsDuplicatedConnectionError extends UniplsError {
  constructor() {
    super("UniplsDuplicatedConnectionError: The WebSocket was already connected or connecting.");
  }
}

/** UniplsSocket が物理接続の状態を通知するために使用する低レベルエラーです。 */
export abstract class UniplsSocketError extends Error {}

/** 低レベルの WebSocket 操作が明示的な close によって終了したことを表します。 */
export class UniplsSocketClosedError extends UniplsSocketError {
  constructor() {
    super("UniplsSocketClosedError: The WebSocket was disconnected.");
  }
}

/** 低レベルの WebSocket 接続が open intent 中に失われたことを表します。 */
export class UniplsSocketDroppedError extends UniplsSocketError {
  constructor() {
    super("UniplsSocketDroppedError: The WebSocket connection was dropped.");
  }
}

/** @internal 未実装の内部経路へ到達したことを表します。 */
export class NotImplementedError extends Error {
  constructor() {
    super("NotImplementedError: This feature is not implemented yet.");
  }
}
