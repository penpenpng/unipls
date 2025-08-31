import { AsyncResult } from './async-result.ts';
import {
  NotImplementedError,
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
import { AsyncResults, type UniplsSubscriber } from './unipls-subscription.ts';
import type {
  UniplsCastOptions,
  UniplsListenParams,
  UniplsNextParams,
  UniplsParams,
  UniplsProvisioner,
  UniplsProvisioningContext,
  UniplsRequestParams,
  UniplsRetrySetupFunction,
  UniplsRetryStrategy,
  UniplsSubscribeParams,
} from './unipls.interface.ts';

export class Unipls<TInput = WebSocketData, TOutput = WebSocketData> {
  #url: string;
  get url(): string {
    return this.#url;
  }
  protected serialize: (data: TInput) => WebSocketData;
  protected deserialize: (data: WebSocketData) => TOutput;
  #WebSocket: WebSocketConstructor;
  #socket?: WebSocket;
  #provisioner?: UniplsProvisioner<TInput, TOutput>;
  #state: UniplsConnectionState = 'closed';
  get state(): UniplsConnectionState {
    return this.#state;
  }
  #intent: UniplsConnectionIntent = 'close';
  get intent() {
    return this.#intent;
  }

  protected events = new EventBus<{
    'raw-open': { socket: WebSocket };
    'raw-message': { socket: WebSocket; data: WebSocketData };
    'raw-close': { socket: WebSocket | 'none'; code: number };
    open: void;
    message: TOutput;
    closed: void;
    dropped: { mayReconnect: boolean };
  }>();

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

    this.events.on('raw-open', async ({ socket }) => {
      if (this.#socket !== socket) {
        return;
      }
      this.#state = 'provisioning';
      await this.#provision();
      this.#state = 'open';
      this.events.emit('open', void 0);
    });
    this.events.on('raw-message', ({ socket, data }) => {
      if (this.#socket !== socket) {
        return;
      }
      const output = this.deserialize(data);
      this.events.emit('message', output);
    });
    this.events.on('raw-close', ({ code }) => {
      if (code === WebSocketCloseClode.NORMAL_CLOSURE) {
        this.#state = 'closed';
        this.events.emit('closed', void 0);
      } else {
        this.#state = 'dropped';
        this.events.emit('dropped', { mayReconnect: true });
      }
    });
  }

  #provision() {
    const result = new AsyncResult<void>();
    const provision = this.#provisioner ?? (({ done }) => done());

    const ctx: UniplsProvisioningContext<TInput, TOutput> = {
      cast: (data) => this.castForce(data),
      request: (data, params) => this.requestForce(data, params),
      listen: (subscriber, params) => this.listen(subscriber, params),
      subscribe: (data, subscriber, params) =>
        this.subscribeForce(data, subscriber, params),
      done: result.resolve,
      session: 0,
      isSessionBeginning: true,
      reconnection: undefined,
    };

    provision(ctx);

    return result.promise;
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
  open(provisioner?: UniplsProvisioner<TInput, TOutput>): Promise<void> {
    if (this.#intent === 'open') {
      throw new UniplsDuplicatedConnectionError();
    }
    // TODO: 初回の接続が即失敗したときには、デフォルトではリトライしない (polite option)

    this.#intent = 'open';
    this.#state = 'connecting';
    this.#provisioner = provisioner;

    const events = this.events.createScope();
    const result = new AsyncResult<void>({
      finally: () => {
        events.cleanup();
      },
    });

    let socket: WebSocket;
    try {
      const WebSocket = this.#WebSocket;
      socket = new WebSocket(this.url);
      this.#socket = socket;

      socket.onopen = () => {
        this.events.emit('raw-open', { socket });
      };
      socket.onmessage = (ev) => {
        this.events.emit('raw-message', { socket, data: ev.data });
      };
      socket.onclose = (ev) => {
        this.events.emit('raw-close', { socket, code: ev.code });
      };
    } catch {
      // When the given URL is invalid, Deno runtime throws SyntaxError.
      result.reject(new UniplsDroppedError());
      return result.promise;
    }

    events.on('open', () => {
      if (this.#socket !== socket) {
        return;
      }
      result.resolve();
    });
    events.on('closed', () => {
      if (this.#socket !== socket) {
        return;
      }
      result.reject(new UniplsClosedError());
    });
    events.on('dropped', ({ mayReconnect }) => {
      if (this.#socket !== socket || mayReconnect) {
        return;
      }
      result.reject(new UniplsDroppedError());
    });

    return result.promise;
  }

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    this.#intent = 'close';

    if (!this.#socket || this.#intent === 'close' || this.#state === 'closed') {
      return Promise.resolve();
    }

    const events = this.events.createScope();
    const result = new AsyncResult<void>({
      finally: () => {
        events.cleanup();
      },
    });

    const closingSocket = this.#socket;
    this.#socket = undefined;

    if (this.#state === 'dropped') {
      result.resolve();
      // socket は既に閉じているので、onclose イベントはもう発火しない。代わりに closed イベントを直接手動で発行する。
      this.events.emit('closed', void 0);
      return result.promise;
    }

    // 以下の理由から、closed イベントの代わりに raw-close イベントで待つ:
    // * 接続が drop したとしても resolve する必要がある
    // * close した socket の同一性を追跡するために、raw-close イベントのイベントパラメータが必要
    events.on('raw-close', ({ socket }) => {
      if (socket === closingSocket) {
        result.resolve();
      }
    });

    closingSocket.close(WebSocketCloseClode.NORMAL_CLOSURE);

    return result.promise;
  }

  drop(): void {
    this.#socket?.close(WebSocketCloseClode.ABNORMAL_CLOSURE);
  }

  /**
   * 0-input 1-output の通信を行います。
   *
   * @throws {UniplsClosedError}
   * @throws {UniplsTimeoutError}
   */
  next(params: UniplsNextParams<TOutput>): Promise<TOutput> {
    void params;
    throw new NotImplementedError();
  }

  /**
   * 0-input N-output の通信を行います。
   *
   * @returns 購読を解除する関数を返します。
   *
   * @throws {UniplsClosedError}
   */
  listen(
    subscriber: UniplsSubscriber<TOutput>,
    params: UniplsListenParams<TOutput>,
  ): () => void {
    if (this.state === 'closed') {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const events = this.events.createScope();
    const results = new AsyncResults<TOutput>({
      subscriber,
      signal: params.signal,
      finally: () => {
        events.cleanup();
      },
    });

    events.on('message', (message) => {
      Unipls.#processMessage({
        message,
        selector: params.terminator,
        processor: results.handleTerminator,
        onSelectorError: results.handleError,
        onProcessorError: (err) => {
          console.warn(
            'An error occurred while processing onTerminator callback:',
            err,
          );
        },
      });
      Unipls.#processMessage({
        message,
        selector: params.selector,
        processor: results.handleMessage,
        onSelectorError: results.handleError,
        onProcessorError: (err) => {
          console.warn(
            'An error occurred while processing onMessage callback:',
            err,
          );
        },
      });
    });

    events.on('dropped', () => {
      if (params.stopListeningOnDropped) {
        results.raiseFatalError(new UniplsDroppedError());
      }
    });
    events.once('closed', () => {
      results.raiseFatalError(new UniplsClosedError());
    });

    return results.unsubscribe;
  }

  /**
   * 1-input 0-output の通信を行います。{@link UniplsProvisioner} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {Promise<void>} WebSocket 接続が確立している間にデータを送信した場合に resolve される Promise を返します。
   *
   * @throws {UniplsClosedError}
   */
  async cast(data: TInput, options?: UniplsCastOptions<TInput>): Promise<void> {
    void data;
    void options;
    throw new NotImplementedError();
  }

  /**
   * {@link Unipls.cast|unipls.cast()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  castForce(data: TInput, options?: UniplsCastOptions<TInput>): Promise<void> {
    void data;
    void options;
    throw new NotImplementedError();
  }

  /**
   * 1-input 1-output の通信を行います。{@link UniplsProvisioner} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {Promise<T>} レスポンスを観測したときに resolve される Promise を返します。
   *
   * @throws {UniplsClosedError}
   * @throws {UniplsTimeoutError}
   */
  request(
    data: TInput,
    params: UniplsRequestParams<TInput, TOutput>,
  ): Promise<TOutput> {
    return this.#request(data, { ...params, force: false });
  }

  /**
   * {@link Unipls.request|unipls.request()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  requestForce(
    data: TInput,
    params: UniplsRequestParams<TInput, TOutput>,
  ): Promise<TOutput> {
    return this.#request(data, { ...params, force: true });
  }

  #request(
    data: TInput,
    params: UniplsRequestParams<TInput, TOutput> & { force: boolean },
  ): Promise<TOutput> {
    if (this.state === 'closed') {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const events = this.events.createScope();
    const result = new AsyncResult<TOutput>({
      finally: () => {
        events.cleanup();
      },
      signal: params.signal,
      timeout: params.timeout,
    });
    let activeRequest = data;
    let activeSelector = params.selector;

    const request = (
      data: TInput,
      { selector }: { selector: (data: TOutput) => boolean },
    ) => {
      if (result.resulted) {
        return;
      }

      this.#enqueue(data, {
        force: params.force,
        signal: result.signal,
      })
        .then(() => {
          activeRequest = data;
          activeSelector = selector;
          // TODO: listening が true のときだけ resolve するオプションがあってもいい
          // listening = true;
        })
        .catch((err) => {
          if (err instanceof UniplsClosedError) {
            result.reject(err);
          }
        });
    };

    if (
      this.state === 'connecting' ||
      this.state === 'provisioning' ||
      this.state === 'open'
    ) {
      request(data, params);
    }

    events.on('message', (message) => {
      Unipls.#processMessage({
        message,
        selector: activeSelector,
        processor: result.resolve,
        onSelectorError: result.reject,
        onProcessorError: () => {
          // ignore because `result.resolve` never throws
        },
      });
    });

    // TODO: 再送処理
    void activeRequest;

    // const onReconnected: UniplsRetrySetupContext<
    //   TInput,
    //   TOutput
    // >['onReconnected'] = (callback) => {
    //   events.once('reconnected', (reconnection) => {
    //     if (result.resulted) {
    //       return;
    //     }

    //     callback({
    //       request,
    //       done: () => {
    //         // いらないかもしれない
    //       },
    //       reconnection,
    //     });
    //   });
    // };

    events.on('dropped', () => {
      if (result.resulted) {
        return;
      }

      // const setupRetry = Unipls.getRetrySetupFunction(params.retry);

      // setupRetry({
      //   onReconnected,
      //   data: activeRequest,
      //   selector: activeSelector,
      //   abort: result.reject,
      // });
    });

    return result.promise;
  }

  /**
   * 1-input N-output の通信を行います。{@link UniplsProvisioner} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns 購読を解除する関数を返します
   *
   * @throws {UniplsClosedError}
   */
  subscribe(
    data: TInput,
    subscriber: UniplsSubscriber<TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    void data;
    void subscriber;
    void params;
    throw new NotImplementedError();
  }

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  subscribeForce(
    data: TInput,
    subscriber: UniplsSubscriber<TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    void data;
    void subscriber;
    void params;
    throw new NotImplementedError();
  }

  /**
   * 現在の接続状態が `"connecting"`, `"provisioning"`, `"open"` のいずれかであるとき、接続状態が `"open"` になるのを待ってからデータを送信します。
   * 接続が drop または close されたとしても、再送信は試みられません。
   */
  #enqueue(
    data: TInput,
    options?: { signal?: AbortSignal; force?: boolean },
  ): Promise<void> {
    const events = this.events.createScope();
    const result = new AsyncResult<void>({
      signal: options?.signal,
      finally: () => {
        events.cleanup();
      },
    });

    if (
      !this.#socket ||
      this.#state === 'closed' ||
      this.#state === 'dropped' ||
      this.#intent === 'close' ||
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
      (this.#state === 'open' ||
        (this.#state === 'provisioning' && options?.force)) &&
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

  protected static getRetrySetupFunction<TInput, TOutput>(
    retry?: UniplsRetryStrategy<TInput, TOutput>,
  ): UniplsRetrySetupFunction<TInput, TOutput> {
    void retry;
    return ({ abort }) => {
      abort();
    };
  }

  static #processMessage<TOutput>({
    message,
    selector,
    processor,
    onSelectorError,
    onProcessorError,
  }: {
    message: TOutput;
    selector?: (message: TOutput) => boolean;
    processor?: (message: TOutput) => void;
    onSelectorError: (message: unknown) => void;
    onProcessorError: (message: unknown) => void;
  }) {
    let selected = false;
    try {
      selected = selector?.(message) ?? false;
    } catch (err) {
      onSelectorError?.(err);
    }
    if (selected) {
      try {
        processor?.(message);
      } catch (err) {
        onProcessorError?.(err);
      }
    }
  }
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
