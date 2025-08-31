export abstract class UniplsError extends Error {}

export class UniplsClosedError extends UniplsError {
  constructor() {
    super('UniplsClosedError: The WebSocket was disconnected.');
  }
}

export class UniplsDroppedError extends UniplsError {
  constructor() {
    super('UniplsDroppedError: The WebSocket connection was dropped.');
  }
}

export class UniplsTimeoutError extends UniplsError {
  constructor() {
    super('UniplsTimeoutError: The operation timed out.');
  }
}

export class UniplsDuplicatedConnectionError extends UniplsError {
  constructor() {
    super(
      'UniplsDuplicatedConnectionError: The WebSocket was already connected or connecting.',
    );
  }
}

export class NotImplementedError extends Error {
  constructor() {
    super('NotImplementedError: This feature is not implemented yet.');
  }
}
