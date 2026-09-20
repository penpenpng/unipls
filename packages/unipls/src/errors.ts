import type {
  ConnectionAttemptSnapshot,
  ConnectionAttemptStage,
  UniplsDrop,
  UniplsDroppedErrorOutcome,
  UniplsOpenErrorOutcome,
} from "./types.ts";

export abstract class UniplsError extends Error {}

export class UniplsOpenError extends UniplsError {
  override readonly name = "UniplsOpenError";
  readonly outcome: UniplsOpenErrorOutcome;
  readonly stage?: ConnectionAttemptStage;
  readonly attempts: readonly ConnectionAttemptSnapshot[];
  readonly drop?: UniplsDrop;
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

export class UniplsClosedError extends UniplsError {
  constructor() {
    super("UniplsClosedError: The WebSocket was disconnected.");
  }
}

export class UniplsDroppedError extends UniplsError {
  override readonly name = "UniplsDroppedError";
  readonly outcome: UniplsDroppedErrorOutcome;
  readonly drop: UniplsDrop;
  readonly attempts: readonly ConnectionAttemptSnapshot[];
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

export class UniplsTimeoutError extends UniplsError {
  constructor() {
    super("UniplsTimeoutError: The operation timed out.");
  }
}

export class UniplsDuplicatedConnectionError extends UniplsError {
  constructor() {
    super("UniplsDuplicatedConnectionError: The WebSocket was already connected or connecting.");
  }
}

/** UniplsSocket が物理接続の状態を通知するために使用する低レベルエラーです。 */
export abstract class UniplsSocketError extends Error {}

export class UniplsSocketClosedError extends UniplsSocketError {
  constructor() {
    super("UniplsSocketClosedError: The WebSocket was disconnected.");
  }
}

export class UniplsSocketDroppedError extends UniplsSocketError {
  constructor() {
    super("UniplsSocketDroppedError: The WebSocket connection was dropped.");
  }
}

export class NotImplementedError extends Error {
  constructor() {
    super("NotImplementedError: This feature is not implemented yet.");
  }
}
