import {
  UniplsAbortedError,
  UniplsDisconnectedError,
  UniplsDuplicatedConnectionError,
  UniplsTimeoutError,
} from './errors.ts';
import type {
  UniplsConnectionState,
  WebSocketConstructor,
  WebSocketData,
} from './types.ts';
import {
  type UniplsSubscriber,
  UniplsSubscription,
} from './unipls-subscription.ts';
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
  UniplsRetryFunction,
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
  }

  protected createWebSocket(): WebSocket {
    try {
      const WebSocket = this.#WebSocket;
      return new WebSocket(this.url);
    } catch (err: unknown) {
      // When the given URL is invalid, Deno runtime throws SyntaxError.

      // TODO: Handle the error
      console.error(err);
      throw err;
    }
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
  connect(initializer?: UniplsInitializer): Promise<void> {}

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): void {}

  /**
   * 0-input 1-output の通信を行います。
   *
   * @throws {UniplsDisconnectedError}
   * @throws {UniplsAbortedError}
   * @throws {UniplsTimeoutError}
   */
  next(params: UniplsNextParams<TOutput>): Promise<T> {}

  /**
   * 0-input N-output の通信を行います。
   *
   * @returns {UniplsSubscription} 購読を表すオブジェクトを返します。
   *
   * @throws {UniplsDisconnectedError}
   */
  listen(
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsListenParams<TOutput>,
  ): UniplsSubscription {}

  /**
   * 1-input 0-output の通信を行います。{@link UniplsInitializer} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {Promise<void>} WebSocket 接続が確立している間にデータを送信した場合に resolve される Promise を返します。
   *
   * @throws {UniplsDisconnectedError}
   * @throws {UniplsAbortedError}
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
   * @throws {UniplsDisconnectedError}
   * @throws {UniplsAbortedError}
   * @throws {UniplsTimeoutError}
   */
  async request<T = TOutput>(
    data: TInput,
    params: UniplsRequestParams<TInput, TOutput>,
  ): Promise<T> {
    if (this.state === 'closed') {
      throw new UniplsDisconnectedError();
    }

    // TODO: AsyncResult class
    // - resolve, reject のいずれか片方が1回のみしか呼び出されないことを保証する
    // - timeout または signal または resolve/reject のいずれかによって abort するような signal を返す
    // - この signal の onabort で cleanup を行う
    // - この signal を enqueue() に渡して、必要があれば送信をキャンセルする
    // - finished === signal.aborted
    const { promise, resolve, reject, finished } = Promise.withResolvers<T>(
      () => {
        // cleanup function
        stopReconnectionListener();
        stopMessageListener();
      },
    );

    // TODO:
    // - AsynResult class の cleanup
    params.signal?.addEventListener('abort', () => {
      stopReconnectionListener();
      stopMessageListener();
      reject(new UniplsAbortedError());
    });

    let activeRequest = data;
    let activeSelector = params.selector;

    if (this.state === 'connecting' || this.state === 'open') {
      this.enqueue(data)
        .then(() => {
          // listening が true のときだけ resolve するオプションがあってもいい
          listening = true;
        })
        .catch(reject);
    }

    const stopReconnectionListener = this.events.on(
      'reconnected',
      (reconnection) => {
        if (finished) {
          return;
        }

        const retryFn = Unipls.getRetryFunction(params.retry);

        retryFn({
          reconnection,
          data: activeRequest,
          selector: activeSelector,
          request: (data, params) => {
            if (finished) {
              return;
            }
            activeRequest = data;
            activeSelector = params.selector;
            this.enqueue(data)
              .then(() => {
                listening = true;
              })
              .catch(reject);
          },
          done: () => {
            // いらないかもしれない
          },
          abort: reject,
        });
      },
    );

    const stopMessageListener = this.events.on('message', (message) => {
      try {
        if (activeSelector(message)) {
          resolve(message);
        }
      } catch (err) {
        reject(err);
      }
    });

    return promise;
  }

  /**
   * {@link Unipls.request|unipls.request()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  requestForce<T = TOutput>(
    data: TInput,
    params: UniplsRequestParams<TInput, TOutput>,
  ): Promise<T> {}

  /**
   * 1-input N-output の通信を行います。{@link UniplsInitializer} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {UniplsSubscription} 購読を表すオブジェクトを返します。
   *
   * @throws {UniplsDisconnectedError}
   * @throws {UniplsAbortedError}
   */
  subscribe(
    data: TInput,
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): UniplsSubscription {}

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  subscribeForce(
    data: TInput,
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): UniplsSubscription {}

  protected getConnectedSocket(): Promise<WebSocket> {}

  protected async enqueue(data: TInput): Promise<void> {}

  protected static getRetryFunction<TInput, TOutput>(
    retry?: UniplsRetryStrategy<TInput, TOutput>,
  ): UniplsRetryFunction<TInput, TOutput> {}

  get state(): UniplsConnectionState {}
}
