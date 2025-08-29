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
import {
  AsyncResults,
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

  protected events = new EventBus<{
    message: TOutput;
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
   * @throws {UniplsClosedError}
   * @throws {UniplsTimeoutError}
   */
  next(params: UniplsNextParams<TOutput>): Promise<T> {}

  /**
   * 0-input N-output の通信を行います。
   *
   * @returns {UniplsSubscription} 購読を表すオブジェクトを返します。
   *
   * @throws {UniplsClosedError}
   */
  listen(
    subscriber: UniplsSubscriber<TOutput>,
    params: UniplsListenParams<TOutput>,
  ): UniplsSubscription {
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
      Unipls.processMessage({
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
      Unipls.processMessage({
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

    events.on('dropeed', () => {
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
      Unipls.processMessage({
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

    events.on('dropeed', () => {
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
   * @returns {UniplsSubscription} 購読を表すオブジェクトを返します。
   *
   * @throws {UniplsClosedError}
   */
  subscribe(
    data: TInput,
    subscriber: UniplsSubscriber<TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): UniplsSubscription {}

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  subscribeForce(
    data: TInput,
    subscriber: UniplsSubscriber<TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): UniplsSubscription {}

  protected getConnectedSocket(): Promise<WebSocket> {}

  protected async enqueue(data: TInput): Promise<void> {
    // 送信が確認できたら resolve する
  }

  protected static getRetrySetupFunction<TInput, TOutput>(
    retry?: UniplsRetryStrategy<TInput, TOutput>,
  ): UniplsRetrySetupFunction<TInput, TOutput> {}

  protected static processMessage<TOutput>({
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
