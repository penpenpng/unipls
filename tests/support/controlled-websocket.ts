import { ObservationQueue } from "./observation-queue.ts";

export interface ControlledCloseEventInit {
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

export interface ClientCloseRequest {
  readonly code?: number;
  readonly reason?: string;
}

type SocketEventType = "open" | "message" | "error" | "close";

export class ControlledWebSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly sent: unknown[] = [];
  readonly closeRequests: ClientCloseRequest[] = [];
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState = this.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  #sendFailure: unknown;
  readonly #listenerCounts = new Map<string, number>();

  constructor(url: string) {
    super();
    this.url = url;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, callback, options);
    if (callback) {
      this.#listenerCounts.set(type, (this.#listenerCounts.get(type) ?? 0) + 1);
    }
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, callback, options);
    if (callback) {
      const current = this.#listenerCounts.get(type) ?? 0;
      this.#listenerCounts.set(type, Math.max(0, current - 1));
    }
  }

  listenerCount(type: SocketEventType): number {
    const propertyHandler = this[`on${type}`] === null ? 0 : 1;
    return propertyHandler + (this.#listenerCounts.get(type) ?? 0);
  }

  failSendsWith(cause: unknown): void {
    this.#sendFailure = cause;
  }

  send(data: unknown): void {
    if (this.#sendFailure !== undefined) {
      throw this.#sendFailure;
    }
    if (this.readyState !== this.OPEN) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeRequests.push(Object.freeze({ code, reason }));
    this.readyState = this.CLOSING;
  }

  emitOpen(): void {
    this.readyState = this.OPEN;
    this.#emit("open", new Event("open"));
  }

  emitMessage(data: unknown): void {
    const event = new MessageEvent("message", { data });
    this.#emit("message", event);
  }

  emitError(cause?: unknown): void {
    const event = new Event("error");
    Object.defineProperty(event, "cause", { value: cause, enumerable: true });
    this.#emit("error", event);
  }

  emitClose({
    code = 1000,
    reason = "",
    wasClean = code === 1000,
  }: ControlledCloseEventInit = {}): void {
    this.readyState = this.CLOSED;
    const event = new Event("close") as CloseEvent;
    Object.defineProperties(event, {
      code: { value: code, enumerable: true },
      reason: { value: reason, enumerable: true },
      wasClean: { value: wasClean, enumerable: true },
    });
    this.#emit("close", event);
  }

  #emit(type: SocketEventType, event: Event): void {
    const handler = this[`on${type}`] as ((event: Event) => void) | null;
    handler?.call(this, event);
    this.dispatchEvent(event);
  }
}

export class ControlledWebSocketServer {
  readonly connections: ControlledWebSocket[] = [];
  readonly created = new ObservationQueue<ControlledWebSocket>();
  readonly WebSocket: typeof WebSocket;

  get current(): ControlledWebSocket {
    const socket = this.connections.at(-1);
    if (!socket) {
      throw new Error("No WebSocket connection has been created");
    }
    return socket;
  }

  constructor() {
    const createSocket = (url: string) => {
      const socket = new ControlledWebSocket(url);
      this.connections.push(socket);
      this.created.push(socket);
      return socket;
    };
    this.WebSocket = class {
      constructor(url: string) {
        return createSocket(url);
      }
    } as unknown as typeof WebSocket;
  }

  connection(index: number): ControlledWebSocket {
    const socket = this.connections[index];
    if (!socket) {
      throw new Error(`Connection ${index} has not been created`);
    }
    return socket;
  }
}
