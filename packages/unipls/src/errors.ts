import type {
  ConnectionAttemptSnapshot,
  ConnectionAttemptStage,
  UniplsOpenErrorOutcome,
} from "./types.ts";

export abstract class UniplsError extends Error {}

export class UniplsOpenError extends UniplsError {
  override readonly name = "UniplsOpenError";
  readonly outcome: UniplsOpenErrorOutcome;
  readonly stage?: ConnectionAttemptStage;
  readonly attempts: readonly ConnectionAttemptSnapshot[];
  override readonly cause: unknown;

  constructor({
    outcome,
    stage,
    attempts,
    cause,
  }: {
    outcome: UniplsOpenErrorOutcome;
    stage?: ConnectionAttemptStage;
    attempts: readonly ConnectionAttemptSnapshot[];
    cause: unknown;
  }) {
    super("The logical session could not become ready.", { cause });
    this.outcome = outcome;
    this.stage = stage;
    this.attempts = attempts;
    this.cause = cause;
  }
}

export class UniplsClosedError extends UniplsError {
  constructor() {
    super("UniplsClosedError: The WebSocket was disconnected.");
  }
}

export class UniplsDroppedError extends UniplsError {
  constructor() {
    super("UniplsDroppedError: The WebSocket connection was dropped.");
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
