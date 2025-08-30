import { AsyncResult } from './async-result.ts';
import {
  UniplsClosedError,
  UniplsDroppedError,
  UniplsDuplicatedConnectionError,
  UniplsTimeoutError,
} from './errors.ts';
import { EventBus } from './event-bus.ts';
import type {
  UniplsConnectionState,
  WebSocketConstructor,
  WebSocketData,
} from './types.ts';
import { AsyncResults, type UniplsSubscriber } from './unipls-subscription.ts';
import type {
  UniplsCastOptions,
  UniplsInitializationContext,
  UniplsInitializer,
  UniplsListenParams,
  UniplsNextParams,
  UniplsParams,
  UniplsRecastContext,
  UniplsRecastFunction,
  UniplsRecastStrategy,
  UniplsRequestParams,
  UniplsRetryContext,
  UniplsRetrySetupContext,
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
  #initializer?: UniplsInitializer<TInput, TOutput>;

  protected events = new EventBus<{
    'raw-open': void;
    'raw-message': WebSocketData;
    'raw-close': number;
    initialized: void;
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

    this.events.on('raw-open', async () => {
      await this.#initialize();
      this.events.emit('initialized', void 0);
    });
    this.events.on('raw-message', (data) => {
      const output = this.deserialize(data);
      this.events.emit('message', output);
    });
    this.events.on('raw-close', (code) => {
      switch (code) {
        case WebSocketCloseClode.NORMAL_CLOSURE:
          this.events.emit('closed', void 0);
          break;
        case WebSocketCloseClode.IRRECOVERABLE_DROP:
          this.events.emit('dropped', { mayReconnect: false });
          break;
        case WebSocketCloseClode.ABNORMAL_CLOSURE:
        default:
          this.events.emit('dropped', { mayReconnect: true });
      }
    });
  }

  #initialize() {
    const result = new AsyncResult<void>();
    const initialize = this.#initializer ?? (({ done }) => done());

    const ctx: UniplsInitializationContext<TInput, TOutput> = {
      cast: (data) => this.castForce(data),
      request: (data, params) => this.requestForce(data, params),
      listen: (subscriber, params) => this.listen(subscriber, params),
      subscribe: (data, subscriber, params) =>
        this.subscribeForce(data, subscriber, params),
      done: result.resolve,
      session: '',
      isSessionBeginning: true,
      reconnection: undefined,
    };

    initialize(ctx);

    return result.promise;
  }

  /**
   * WebSocket 接続を確立します。
   *
   * @param {UniplsInitializer} initializer WebSocket 接続成功後の初期化処理を定義します。省略した場合は `({ done }) => done()` と同等になります。
   * @returns {Promise<void>} WebSocket 接続と初期化が完了したことを表す Promise を返します。
   *
   * @throws {UniplsDuplicatedConnectionError} WebSocket が既に接続されているか、接続を試行中の場合に例外を投げます。
   *
   * @remarks
   * 初期化が終了したら必ず {@link UniplsInitializationContext.done|done()} を呼び出さなければなりません。
   */
  connect(initializer?: UniplsInitializer<TInput, TOutput>): Promise<void> {
    // TODO: 接続済みか接続中のときに UniplsDuplicatedConnectionError
    // TODO: 初回の接続が即失敗したときには、デフォルトではリトライしない (polite option)

    const events = this.events.createScope();
    const result = new AsyncResult<void>({
      finally: () => {
        events.cleanup();
      },
    });

    events.once('initialized', () => {
      result.resolve();
    });
    events.once('closed', () => {
      result.reject(new UniplsClosedError());
    });
    const off = events.on('dropped', ({ mayReconnect }) => {
      if (!mayReconnect) {
        result.reject(new UniplsDroppedError());
        off();
      }
    });

    this.#initializer = initializer;

    try {
      const WebSocket = this.#WebSocket;
      const socket = new WebSocket(this.url);

      socket.onopen = () => {
        this.events.emit('raw-open', void 0);
      };
      socket.onmessage = (ev) => {
        this.events.emit('raw-message', ev.data);
      };
      socket.onclose = (ev) => {
        this.events.emit('raw-close', ev.code);
      };

      this.#socket = socket;
    } catch {
      // When the given URL is invalid, Deno runtime throws SyntaxError.
      this.events.emit('raw-close', WebSocketCloseClode.IRRECOVERABLE_DROP);
    }

    return result.promise;
  }

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): void {
    this.#socket?.close(WebSocketCloseClode.NORMAL_CLOSURE);
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
    return Promise.resolve<TOutput>();
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
   * 1-input 0-output の通信を行います。{@link UniplsInitializer} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {Promise<void>} WebSocket 接続が確立している間にデータを送信した場合に resolve される Promise を返します。
   *
   * @throws {UniplsClosedError}
   */
  async cast(
    data: TInput,
    options?: UniplsCastOptions<TInput>,
  ): Promise<void> {}

  /**
   * {@link Unipls.cast|unipls.cast()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  castForce(data: TInput, options?: UniplsCastOptions<TInput>): Promise<void> {}

  /**
   * 1-input 1-output の通信を行います。{@link UniplsInitializer} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
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
      params: { selector: (data: TOutput) => boolean },
    ) => {
      if (result.resulted) {
        return;
      }

      this.enqueue(data, {
        force: params.force,
        signal: result.signal,
      })
        .then(() => {
          activeRequest = data;
          activeSelector = selector;
          // listening が true のときだけ resolve するオプションがあってもいい
          listening = true;
        })
        .catch((err) => {
          if (err instanceof UniplsClosedError) {
            result.reject(err);
          }
        });
    };

    if (this.state === 'connecting' || this.state === 'open') {
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

    const onReconnected: UniplsRetrySetupContext<
      TInput,
      TOutput
    >['onReconnected'] = (callback) => {
      events.once('reconnected', (reconnection) => {
        if (result.resulted) {
          return;
        }

        callback({
          request,
          done: () => {
            // いらないかもしれない
          },
          reconnection,
        });
      });
    };

    events.on('dropped', () => {
      if (result.resulted) {
        return;
      }

      const setupRetry = Unipls.getRetrySetupFunction(params.retry);

      setupRetry({
        onReconnected,
        data: activeRequest,
        selector: activeSelector,
        abort: result.reject,
      });
    });

    return result.promise;
  }

  /**
   * 1-input N-output の通信を行います。{@link UniplsInitializer} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
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
    return () => {};
  }

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  subscribeForce(
    data: TInput,
    subscriber: UniplsSubscriber<TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    return () => {};
  }

  protected async enqueue(data: TInput): Promise<void> {
    // 送信が確認できたら resolve する
  }

  protected static getRetrySetupFunction<TInput, TOutput>(
    retry?: UniplsRetryStrategy<TInput, TOutput>,
  ): UniplsRetrySetupFunction<TInput, TOutput> {}

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

  get state(): UniplsConnectionState {}
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
   * 1006 is a reserved value and MUST NOT be set as a status code in a
   * Close control frame by an endpoint.  It is designated for use in
   * applications expecting a status code to indicate that the
   * connection was closed abnormally, e.g., without sending or
   * receiving a Close control frame.
   *
   * See also: https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1
   */
  ABNORMAL_CLOSURE: 1006,
  /**
   * Status codes in the range 3000-3999 are reserved for use by
   * libraries, frameworks, and applications.  These status codes are
   * registered directly with IANA.  The interpretation of these codes
   * is undefined by this protocol.
   *
   * See also: https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.2
   */
  IRRECOVERABLE_DROP: 3000,
} as const;
