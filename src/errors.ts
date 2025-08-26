export abstract class UniplsError extends Error {}

export class UniplsDisconnectedError extends UniplsError {
  constructor() {
    super('UniplsClosedError: The WebSocket was disconnected.');
  }
}

export class UniplsTimeoutError extends UniplsError {
  constructor() {
    super('UniplsTimeoutError: The operation timed out.');
  }
}

export class UniplsAbortedError extends UniplsError {
  constructor() {
    super('UniplsAbortedError: The operation was aborted.');
  }
}

export class UniplsDuplicatedConnectionError extends UniplsError {
  constructor() {
    super(
      'UniplsDuplicatedConnectionError: The WebSocket was already connected or connecting.',
    );
  }
}
