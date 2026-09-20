import { AsyncResult } from "./async-result.ts";
import {
  UniplsDuplicatedConnectionError,
  UniplsSocketClosedError,
  UniplsSocketDroppedError,
  UniplsTimeoutError,
} from "./errors.ts";
import { EventBus } from "./event-bus.ts";
import type {
  UniplsConnectionIntent,
  UniplsConnectionState,
  WebSocketConstructor,
  WebSocketData,
} from "./types.ts";
import type { UniplsParams } from "./unipls.interface.ts";

/**
 * 基礎的な機能を備えた WebSocket クライアントです。
 *
 * - コネクションプロビジョニング
 * - 同インスタンス上での (手動の) 再接続
 * - メッセージのシリアライズ/デシリアライズ
 * - drop イベントの検知
 */
export class UniplsSocket<TInput = WebSocketData, TOutput = WebSocketData> {
  #url: string;
  get url(): string {
    return this.#url;
  }
  protected serialize: (data: TInput) => WebSocketData;
  protected deserialize: (data: WebSocketData) => TOutput;
  protected timeout: number;
  #WebSocket: WebSocketConstructor;
  #epoch: UniplsTransportEpoch = UniplsTransportEpoch.dead();
  #events = new EventBus<UniplsSocketPublicEvents<TOutput> & UniplsSocketInternalEvents>();
  get events(): EventBus<UniplsSocketPublicEvents<TOutput>> {
    return this.#events as EventBus<UniplsSocketPublicEvents<TOutput>>;
  }
  get state(): UniplsConnectionState {
    return this.#epoch.connection.state;
  }
  get intent() {
    return this.#epoch.intent;
  }
  get transportEpochId() {
    return this.#epoch.id;
  }
  get #socket() {
    return this.#epoch.connection.socket;
  }

  constructor({
    url,
    serializer = (data) => data as WebSocketData,
    deserializer = (data) => data as TOutput,
    WebSocket = globalThis.WebSocket,
    timeout = 5000,
  }: UniplsParams<TInput, TOutput>) {
    this.#url = url;
    this.serialize = serializer;
    this.deserialize = deserializer;
    this.timeout = timeout;

    this.#WebSocket = WebSocket;
    if (!this.#WebSocket) {
      throw new Error("WebSocket constructor was not provided.");
    }

    this.#events.on("raw-open", async ({ session }) => {
      session.connection.state = "provisioning";

      try {
        await session.provisioner?.();
        session.connection.state = "open";
        this.#events.emit("open", { session });
      } catch (error) {
        session.intent = "close";
        session.connection.state = "closed";
        this.#events.emit("failed", { session, error });
        session.connection.socket?.close(UniplsWebSocketCloseCode.NORMAL_CLOSURE);
      }
    });

    this.#events.on("raw-message", ({ data, session }) => {
      try {
        const message = this.deserialize(data);
        this.#events.emit("message", {
          session,
          message,
        });
      } catch (error) {
        this.#events.emit("error", {
          session,
          error,
        });
      }
    });

    this.#events.on("raw-close", ({ session, code }) => {
      if (code === UniplsWebSocketCloseCode.NORMAL_CLOSURE) {
        session.connection.state = "closed";
        this.#events.emit("closed", { session });
      } else {
        session.connection.state = "dropped";
        this.#events.emit("dropped", { session, code });
      }
    });
  }

  /**
   * WebSocket 接続が未確立ならば新規の接続を試みて、接続とプロビジョニングに成功したときに解決する Promise を返します。
   *
   * @param {UniplsProvisioner} provisioner WebSocket 接続成功後の初期化処理を定義します。
   *
   * @throws {UniplsDuplicatedConnectionError} WebSocket が既に接続されているか、接続を試行中の場合に例外を投げます。
   */
  open(provisioner?: () => Promise<void>): Promise<void> {
    if (this.intent === "open" && this.state !== "dropped") {
      throw new UniplsDuplicatedConnectionError();
    }
    const session = UniplsTransportEpoch.create(provisioner);
    session.connection.state = "connecting";
    this.#epoch = session;

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const events = this.#events.spawnEventBusView();
    const result = new AsyncResult<void>({
      finally: () => {
        events.dispose();
        if (timeoutTimer) clearTimeout(timeoutTimer);
      },
    });

    let socket: WebSocket;
    try {
      session.connection.socket = socket = this.#createSocket(session);
    } catch (err) {
      result.reject(err);
      return result.promise;
    }

    events.on("open", (ev) => {
      if (ev.session.id !== session.id) {
        return;
      }
      result.resolve();
    });
    events.on("closed", (ev) => {
      if (ev.session.id !== session.id) {
        return;
      }
      result.reject(new UniplsSocketClosedError());
    });
    events.on("dropped", (ev) => {
      if (ev.session.id !== session.id) {
        return;
      }
      result.reject(new UniplsSocketDroppedError());
    });
    events.on("failed", (ev) => {
      if (ev.session.id !== session.id) {
        return;
      }
      result.reject(ev.error);
    });

    timeoutTimer = setTimeout(() => {
      if (result.resulted) {
        return;
      }

      result.reject(new UniplsTimeoutError());
      session.connection.state = "dropped";
      timeoutTimer = undefined;
      socket.close(UniplsWebSocketCloseCode.MARKED_AS_TIMED_OUT);
    }, this.timeout);

    return result.promise;
  }

  #createSocket(session: UniplsTransportEpoch): WebSocket {
    let socket: WebSocket;
    try {
      const WebSocket = this.#WebSocket;
      socket = new WebSocket(this.url);
    } catch {
      // When the given URL is invalid, Deno runtime throws SyntaxError.
      throw new UniplsSocketDroppedError();
    }

    socket.onopen = () => {
      this.#events.emit("raw-open", { session });
    };
    socket.onmessage = (ev) => {
      this.#events.emit("raw-message", { session, data: ev.data });
    };
    socket.onclose = (ev) => {
      this.#events.emit("raw-close", { session, socket, code: ev.code });
    };

    return socket;
  }

  /**
   * WebSocket 接続を切断します。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    if (!this.#socket || this.intent === "close" || this.state === "closed") {
      return Promise.resolve();
    }

    this.#epoch.intent = "close";

    const targetSession = this.#epoch;
    const targetSessionId = this.#epoch.id;

    const events = this.#events.spawnEventBusView();
    const result = new AsyncResult<void>({
      finally: () => events.dispose(),
    });

    if (this.state === "dropped") {
      result.resolve();
      this.#events.emit("closed", { session: targetSession });
      return result.promise;
    }

    events.on("closed", ({ session }) => {
      if (targetSessionId !== session.id) return;
      result.resolve();
    });
    events.on("dropped", ({ session }) => {
      if (targetSessionId !== session.id) return;
      result.resolve();
    });

    this.#socket.close(UniplsWebSocketCloseCode.NORMAL_CLOSURE);

    return result.promise;
  }

  drop(): void {
    this.#socket?.close(UniplsWebSocketCloseCode.ABNORMAL_CLOSURE);
  }

  /**
   * 現在の接続状態が `"connecting"`, `"provisioning"`, `"open"` のいずれかであるとき、接続状態が `"open"` になるのを待ってからデータを送信します。
   * 接続が drop または close されたとしても、再送信は試みられません。
   */
  enqueue(data: TInput, options?: { signal?: AbortSignal; force?: boolean }): Promise<void> {
    const events = this.#events.spawnEventBusView();
    const result = new AsyncResult<void>({
      signal: options?.signal,
      finally: () => events.dispose(),
    });

    const send = () => {
      if (!this.#socket || this.#socket.readyState !== WebSocketReadyState.OPEN) {
        result.reject(new UniplsSocketClosedError());
        return;
      }

      try {
        this.#socket.send(this.serialize(data));
        result.resolve();
      } catch (error) {
        result.reject(error);
      }
    };

    if (!this.#socket || this.state === "closed" || this.intent === "close") {
      result.reject(new UniplsSocketClosedError());
      return result.promise;
    }

    if (this.state === "dropped") {
      result.reject(new UniplsSocketDroppedError());
      return result.promise;
    }

    if (options?.signal?.aborted) {
      result.reject(options.signal.reason);
      return result.promise;
    }

    if (
      (this.state === "open" || (this.state === "provisioning" && options?.force)) &&
      this.#socket?.readyState === WebSocketReadyState.OPEN
    ) {
      send();
      return result.promise;
    }

    if (options?.force) {
      events.once("raw-open", () => {
        send();
        result.resolve();
      });
    } else {
      events.once("open", () => {
        send();
        result.resolve();
      });
    }
    events.once("closed", () => {
      result.reject(new UniplsSocketClosedError());
    });
    events.once("dropped", () => {
      result.reject(new UniplsSocketDroppedError());
    });
    events.once("failed", ({ error }) => {
      result.reject(error);
    });

    return result.promise;
  }
}

// FIXME: session は外部から操作不可能であるべき。id などのみ公開するに留めたほうがいい
export interface UniplsSocketPublicEvents<TOutput> {
  open: { session: UniplsTransportEpoch };
  message: { session: UniplsTransportEpoch; message: TOutput };
  error: { session: UniplsTransportEpoch; error: unknown };
  closed: { session: UniplsTransportEpoch };
  dropped: { session: UniplsTransportEpoch; code?: number };
  failed: { session: UniplsTransportEpoch; error: unknown };
}

interface UniplsSocketInternalEvents {
  "raw-open": { session: UniplsTransportEpoch };
  "raw-message": { session: UniplsTransportEpoch; data: WebSocketData };
  "raw-close": { session: UniplsTransportEpoch; socket: WebSocket; code: number };
}

type UniplsProvisioner = () => Promise<void>;

// FIXME: ドメインを記述する
class UniplsTransportEpoch {
  static #nextEpochId = 1;

  #id: number;
  get id() {
    return this.#id;
  }

  #provisioner?: UniplsProvisioner;
  get provisioner() {
    return this.#provisioner;
  }

  intent: UniplsConnectionIntent = "open";
  connection: UniplsTransportConnection;

  static create(provisioner?: UniplsProvisioner) {
    return new UniplsTransportEpoch(this.#nextEpochId++, provisioner);
  }

  static dead() {
    const epoch = new UniplsTransportEpoch(NaN);
    epoch.intent = "close";
    epoch.connection.state = "closed";
    return epoch;
  }

  private constructor(epochId: number, provisioner?: UniplsProvisioner) {
    this.#id = epochId;
    this.#provisioner = provisioner;
    this.connection = new UniplsTransportConnection(epochId);
  }
}

class UniplsTransportConnection {
  state: UniplsConnectionState = "closed";
  socket?: WebSocket;

  constructor(public epochId: number) {}
}

export const UniplsWebSocketCloseCode = {
  /**
   * 1000 indicates a normal closure, meaning that the purpose for
   * which the connection was established has been fulfilled.
   *
   * See also: https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1
   */
  NORMAL_CLOSURE: 1000,
  /**
   * Status codes in the range 3000-3999 are reserved for use by
   * libraries, frameworks, and applications.  These status codes are
   * registered directly with IANA.  The interpretation of these codes
   * is undefined by this protocol.
   *
   * See also: https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.2
   */
  IRRECOVERABLE_DROP: 3000,
  /**
   * 1006 はクライアントサイドからは送信できないため、代わりに 3001 を使用します。
   */
  ABNORMAL_CLOSURE: 3001,
  MARKED_AS_TIMED_OUT: 3002,
} as const;

const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
