import { AsyncResult } from './async-result.ts';
import {
  UniplsClosedError,
  UniplsDroppedError,
  UniplsDuplicatedConnectionError,
} from './errors.ts';
import { EventBus } from './event-bus.ts';
import type {
  UniplsConnectionIntent,
  UniplsConnectionState,
  WebSocketConstructor,
  WebSocketData,
} from './types.ts';
import type { UniplsParams } from './unipls.interface.ts';

export class UniplsSocket<TInput = WebSocketData, TOutput = WebSocketData> {
  #url: string;
  get url(): string {
    return this.#url;
  }
  protected serialize: (data: TInput) => WebSocketData;
  protected deserialize: (data: WebSocketData) => TOutput;
  #WebSocket: WebSocketConstructor;
  #session: UniplsSessionState = UniplsSessionState.dead();
  #events = new EventBus<
    UniplsSocketPublicEvents<TOutput> & UniplsSocketRawEvents
  >();
  get events(): EventBus<UniplsSocketPublicEvents<TOutput>> {
    return this.#events as EventBus<UniplsSocketPublicEvents<TOutput>>;
  }
  get state(): UniplsConnectionState {
    return this.#session.conn.state;
  }
  get intent() {
    return this.#session.intent;
  }
  get sessionId() {
    return this.#session.id;
  }
  get #socket() {
    return this.#session.conn.socket;
  }

  constructor({
    url,
    serializer,
    deserializer,
    WebSocket,
  }: UniplsParams<TInput, TOutput>) {
    this.#url = url;
    this.serialize = serializer ?? ((data) => data as WebSocketData);
    this.deserialize = deserializer ?? ((data) => data as TOutput);

    this.#WebSocket = WebSocket ?? globalThis.WebSocket;
    if (!this.#WebSocket) {
      throw new Error('WebSocket constructor was not provided.');
    }

    this.#events.on('raw-open', async ({ session }) => {
      session.conn.state = 'provisioning';
      await session.provisioner?.();
      session.conn.state = 'open';
      this.#events.emit('open', { session });
    });

    this.#events.on('raw-message', ({ data, session }) => {
      const message = this.deserialize(data);
      this.#events.emit('message', {
        session,
        message,
      });
    });

    this.#events.on('raw-close', ({ session, code }) => {
      if (code === WebSocketCloseClode.NORMAL_CLOSURE) {
        session.conn.state = 'closed';
        this.#events.emit('closed', { session });
      } else {
        session.conn.state = 'dropped';
        this.#events.emit('dropped', { session, mayReconnect: true });
      }
    });
  }

  /**
   * WebSocket 接続を確立します。
   *
   * @param {UniplsProvisioner} provisioner WebSocket 接続成功後の初期化処理を定義します。省略した場合は `({ done }) => done()` と同等になります。
   * @returns {Promise<void>} WebSocket 接続と初期化が完了したことを表す Promise を返します。
   *
   * @throws {UniplsDuplicatedConnectionError} WebSocket が既に接続されているか、接続を試行中の場合に例外を投げます。
   *
   * @remarks
   * 初期化が終了したら必ず {@link UniplsProvisioningContext.done|done()} を呼び出さなければなりません。
   */
  open(provisioner?: () => Promise<void>): Promise<void> {
    if (this.intent === 'open') {
      throw new UniplsDuplicatedConnectionError();
    }
    // TODO: 初回の接続が即失敗したときには、デフォルトではリトライしない (polite option)
    const session = UniplsSessionState.create(provisioner);
    session.conn.state = 'connecting';
    this.#session = session;

    const events = this.#events.createScope();
    const result = new AsyncResult<void>({
      finally: () => {
        events.cleanup();
      },
    });

    let socket: WebSocket;
    try {
      const WebSocket = this.#WebSocket;
      socket = new WebSocket(this.url);
    } catch {
      // When the given URL is invalid, Deno runtime throws SyntaxError.
      result.reject(new UniplsDroppedError());
      return result.promise;
    }

    session.conn.socket = socket;

    socket.onopen = () => {
      this.#events.emit('raw-open', { session });
    };
    socket.onmessage = (ev) => {
      this.#events.emit('raw-message', { session, data: ev.data });
    };
    socket.onclose = (ev) => {
      this.#events.emit('raw-close', { session, socket, code: ev.code });
    };

    events.on('open', () => {
      result.resolve();
    });
    events.on('closed', () => {
      result.reject(new UniplsClosedError());
    });
    events.on('dropped', ({ mayReconnect }) => {
      if (mayReconnect) return;
      result.reject(new UniplsDroppedError());
    });

    return result.promise;
  }

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    if (!this.#socket || this.intent === 'close' || this.state === 'closed') {
      return Promise.resolve();
    }

    this.#session.intent = 'close';

    const targetSession = this.#session;
    const targetSessionId = this.#session.id;

    const events = this.#events.createScope();
    const result = new AsyncResult<void>({
      finally: () => {
        events.cleanup();
      },
    });

    if (this.state === 'dropped') {
      result.resolve();
      this.#events.emit('closed', { session: targetSession });
      return result.promise;
    }

    events.on('closed', ({ session }) => {
      if (targetSessionId !== session.id) return;
      result.resolve();
    });
    events.on('dropped', ({ session }) => {
      if (targetSessionId !== session.id) return;
      result.resolve();
    });

    this.#socket.close(WebSocketCloseClode.NORMAL_CLOSURE);

    return result.promise;
  }

  drop(): void {
    this.#socket?.close(WebSocketCloseClode.ABNORMAL_CLOSURE);
  }

  /**
   * 現在の接続状態が `"connecting"`, `"provisioning"`, `"open"` のいずれかであるとき、接続状態が `"open"` になるのを待ってからデータを送信します。
   * 接続が drop または close されたとしても、再送信は試みられません。
   */
  enqueue(
    data: TInput,
    options?: { signal?: AbortSignal; force?: boolean },
  ): Promise<void> {
    const events = this.#events.createScope();
    const result = new AsyncResult<void>({
      signal: options?.signal,
      finally: () => {
        events.cleanup();
      },
    });

    if (
      !this.#socket ||
      this.state === 'closed' ||
      this.state === 'dropped' ||
      this.intent === 'close' ||
      options?.signal?.aborted
    ) {
      result.reject();
      return result.promise;
    }

    const send = () => {
      if (
        !this.#socket ||
        this.#socket.readyState !== WebSocketReadyState.OPEN
      ) {
        result.reject();
        return;
      }

      try {
        this.#socket.send(this.serialize(data));
        result.resolve();
      } catch {
        result.reject();
      }
    };

    if (
      (this.state === 'open' ||
        (this.state === 'provisioning' && options?.force)) &&
      this.#socket?.readyState === WebSocketReadyState.OPEN
    ) {
      send();
      return result.promise;
    }

    if (options?.force) {
      events.once('raw-open', () => {
        send();
        result.resolve();
      });
    } else {
      events.once('open', () => {
        send();
        result.resolve();
      });
    }
    events.once('closed', () => {
      result.reject();
    });
    events.once('dropped', () => {
      result.reject();
    });

    return result.promise;
  }
}

export interface UniplsSocketPublicEvents<TOutput> {
  open: { session: UniplsSessionState };
  message: { session: UniplsSessionState; message: TOutput };
  closed: { session: UniplsSessionState };
  dropped: { session: UniplsSessionState; mayReconnect: boolean };
}

interface UniplsSocketRawEvents {
  'raw-open': { session: UniplsSessionState };
  'raw-message': { session: UniplsSessionState; data: WebSocketData };
  'raw-close': { session: UniplsSessionState; socket: WebSocket; code: number };
}

type UniplsProvisioner = () => Promise<void>;

class UniplsSessionState {
  static #nextSessionId = 1;

  #id: number;
  get id() {
    return this.#id;
  }

  #provisioner?: UniplsProvisioner;
  get provisioner() {
    return this.#provisioner;
  }

  intent: UniplsConnectionIntent = 'open';
  conn: UniplsConnection;

  static create(provisioner?: UniplsProvisioner) {
    return new UniplsSessionState(this.#nextSessionId++, provisioner);
  }

  static dead() {
    const session = new UniplsSessionState(NaN);
    session.intent = 'close';
    session.conn.state = 'closed';
    return session;
  }

  private constructor(sessionId: number, provisioner?: UniplsProvisioner) {
    this.#id = sessionId;
    this.#provisioner = provisioner;
    this.conn = new UniplsConnection(sessionId);
  }
}

class UniplsConnection {
  state: UniplsConnectionState = 'closed';
  socket?: WebSocket;

  constructor(public sessionId: number) {}
}

const WebSocketCloseClode = {
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
} as const;

const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
