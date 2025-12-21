import { AsyncResult } from './async-result.ts';
import {
  NotImplementedError,
  UniplsClosedError,
  UniplsDroppedError,
} from './errors.ts';
import type { UniplsConnectionState, WebSocketData } from './types.ts';
import { UniplsSocket } from './unipls-socket';
import { AsyncResults, type UniplsSubscriber } from './unipls-subscription.ts';
import type {
  UniplsCastOptions,
  UniplsListenOptions,
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
  #socket: UniplsSocket<TInput, TOutput>;
  get url(): string {
    return this.#socket.url;
  }
  get state(): UniplsConnectionState {
    return this.#socket.state;
  }
  get intent() {
    return this.#socket.intent;
  }
  protected get events() {
    return this.#socket.events;
  }

  constructor(params: UniplsParams<TInput, TOutput>) {
    this.#socket = new UniplsSocket(params);
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
    // TODO: 初回の接続が即失敗したときには、デフォルトではリトライしない (polite option)
    return this.#socket.open(async () => {
      const result = new AsyncResult<void>();
      const provision = provisioner ?? (({ done }) => done());

      const ctx: UniplsProvisioningContext<TInput, TOutput> = {
        cast: (data) => this.castForce(data),
        request: (data, params) => this.requestForce(data, params),
        listen: (params) => this.listen(params),
        subscribe: (data, params) => this.subscribeForce(data, params),
        done: result.resolve,
        session: 0,
        isSessionBeginning: true,
      };

      provision(ctx);

      return result.promise;
    });
  }

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    return this.#socket.close();
  }

  drop(): void {
    return this.#socket.drop();
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
    params: UniplsSubscriber<TOutput> & UniplsListenOptions<TOutput>,
  ): () => void {
    if (this.state === 'closed') {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const events = this.events.spawnReadonlyBus();
    const results = new AsyncResults<TOutput>({
      subscriber: params,
      signal: params.signal,
      finally: () => {
        events.dispose();
      },
    });

    events.on('message', ({ message }) => {
      Unipls.#processMessage({
        message,
        selector: params.terminator ?? (() => false),
        onSelected: results.handleTerminator,
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
        selector: params.selector ?? (() => true),
        onSelected: results.handleMessage,
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

    const events = this.events.spawnReadonlyBus();
    const result = new AsyncResult<TOutput>({
      finally: () => {
        events.dispose();
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

      this.#socket
        .enqueue(data, {
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

    events.on('message', ({ message }) => {
      Unipls.#processMessage({
        message,
        selector: activeSelector,
        onSelected: result.resolve,
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

      const setupRetry = Unipls.getRetrySetupFunction(params.retry);

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
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    void data;
    void params;
    throw new NotImplementedError();
  }

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  subscribeForce(
    data: TInput,
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    void data;
    void params;
    throw new NotImplementedError();
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
    onSelected: processor,
    onSelectorError,
    onProcessorError,
  }: {
    message: TOutput;
    selector: (message: TOutput) => boolean;
    onSelected?: (message: TOutput) => void;
    onSelectorError: (message: unknown) => void;
    onProcessorError: (message: unknown) => void;
  }) {
    let selected = false;
    try {
      selected = selector(message);
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
