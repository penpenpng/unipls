export abstract class UniplsError extends Error {}

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
