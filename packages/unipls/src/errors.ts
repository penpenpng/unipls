import type {
  ConnectionAttemptSnapshot,
  ConnectionAttemptStage,
  UniplsDrop,
  UniplsDroppedErrorOutcome,
  UniplsOpenErrorOutcome,
} from "./types.ts";

function isFrozenDrop(drop: UniplsDrop): boolean {
  return (
    Object.isFrozen(drop) &&
    Object.isFrozen(drop.source) &&
    (drop.source.type !== "detector" || Object.isFrozen(drop.source.detector)) &&
    (drop.close === undefined || Object.isFrozen(drop.close))
  );
}

function freezeDrop(drop: UniplsDrop): UniplsDrop {
  if (isFrozenDrop(drop)) return drop;
  const source =
    drop.source.type === "detector"
      ? Object.freeze({
          type: "detector" as const,
          detector: Object.freeze({ ...drop.source.detector }),
        })
      : Object.freeze({ ...drop.source });
  return Object.freeze({
    ...drop,
    source,
    ...(drop.close === undefined ? {} : { close: Object.freeze({ ...drop.close }) }),
  });
}

function freezeAttempts(
  attempts: readonly ConnectionAttemptSnapshot[],
): readonly ConnectionAttemptSnapshot[] {
  if (
    Object.isFrozen(attempts) &&
    attempts.every(
      (attempt) =>
        Object.isFrozen(attempt) &&
        (!("drop" in attempt) || attempt.drop === undefined || isFrozenDrop(attempt.drop)),
    )
  ) {
    return attempts;
  }
  return Object.freeze(
    attempts.map((attempt) =>
      Object.freeze({
        ...attempt,
        ...("drop" in attempt && attempt.drop ? { drop: freezeDrop(attempt.drop) } : {}),
      }),
    ),
  );
}

/** Unipls の公開 API が通知するエラーの基底クラスです。 */
export abstract class UniplsError extends Error {}

/** 公開 API が現在の lifecycle では受け付けられない方法で呼ばれたことを表します。 */
export class UniplsInvalidUsageError extends UniplsError {
  override readonly name = "UniplsInvalidUsageError";

  constructor(message: string) {
    super(message);
    Object.freeze(this);
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
    this.attempts = freezeAttempts(attempts);
    this.cause = cause;
    this.drop = drop === undefined ? undefined : freezeDrop(drop);
    Object.freeze(this);
  }
}

/** 利用者が終了した論理セッションに対して操作を継続できないことを表します。 */
export class UniplsClosedError extends UniplsError {
  override readonly name = "UniplsClosedError";

  constructor() {
    super("The logical session was closed by the user.");
    Object.freeze(this);
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
    this.drop = freezeDrop(drop);
    this.attempts = freezeAttempts(attempts);
    this.cause = cause;
    Object.freeze(this);
  }
}

/** 指定された待機時間内に操作が完了しなかったことを表します。 */
export class UniplsTimeoutError extends UniplsError {
  override readonly name = "UniplsTimeoutError";

  constructor() {
    super("The operation timed out.");
    Object.freeze(this);
  }
}

/** stream の未処理メッセージが指定された buffer capacity を超えたことを表します。 */
export class UniplsBufferOverflowError extends UniplsError {
  override readonly name = "UniplsBufferOverflowError";

  constructor() {
    super("The stream buffer capacity was exceeded.");
    Object.freeze(this);
  }
}

/** UniplsSocket が物理接続の状態を通知するために使用する低レベルエラーです。 */
export abstract class UniplsSocketError extends Error {}

/** 低レベルの WebSocket 操作が明示的な close によって終了したことを表します。 */
export class UniplsSocketClosedError extends UniplsSocketError {
  override readonly name = "UniplsSocketClosedError";

  constructor() {
    super("The WebSocket was disconnected.");
    Object.freeze(this);
  }
}

/** 低レベルの WebSocket 接続が open intent 中に失われたことを表します。 */
export class UniplsSocketDroppedError extends UniplsSocketError {
  override readonly name = "UniplsSocketDroppedError";

  constructor() {
    super("The WebSocket connection was dropped.");
    Object.freeze(this);
  }
}

/** @internal 未実装の内部経路へ到達したことを表します。 */
export class NotImplementedError extends Error {
  constructor() {
    super("NotImplementedError: This feature is not implemented yet.");
  }
}
