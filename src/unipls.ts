import { AsyncResult } from './async-result.ts';
import { AsyncResults, type UniplsSubscriber } from './async-results.ts';
import {
  NotImplementedError,
  UniplsClosedError,
  UniplsDroppedError,
} from './errors.ts';
import type { EventBus } from './event-bus';
import type {
  SessionId,
  UniplsConnectionState,
  WebSocketData,
} from './types.ts';
import { UniplsSocket, type UniplsSocketPublicEvents } from './unipls-socket';
import type {
  UniplsCastOptions,
  UniplsListenOptions,
  UniplsMessageFactory,
  UniplsNextParams,
  UniplsParams,
  UniplsProvisioner,
  UniplsProvisioningContext,
  UniplsRequestParams,
  UniplsRetrySetupFunction,
  UniplsRetryStrategy,
  UniplsSubscribeParams,
} from './unipls.interface.ts';

type UniplsEvents<TOutput> = UniplsSocketPublicEvents<TOutput> & {
  reconnect: {
    previousSessionId: SessionId;
    sessionId: SessionId;
  };
};

export class Unipls<TInput = WebSocketData, TOutput = WebSocketData> {
  #socket: UniplsSocket<TInput, TOutput>;
  #provisioner?: UniplsProvisioner<TInput, TOutput>;
  #provisionedSessions = new Set<number>();
  #reconnectPromise?: Promise<void>;
  get url(): string {
    return this.#socket.url;
  }
  get state(): UniplsConnectionState {
    return this.#socket.state;
  }
  get intent() {
    return this.#socket.intent;
  }
  protected get events(): EventBus<UniplsEvents<TOutput>> {
    return this.#socket.events as EventBus<UniplsEvents<TOutput>>;
  }
  get on() {
    return this.events.on.bind(this.events);
  }
  get off() {
    return this.events.off.bind(this.events);
  }

  constructor(params: UniplsParams<TInput, TOutput>) {
    this.#socket = new UniplsSocket(params);

    this.events.on('dropped', ({ session }) => {
      this.#handleDropped(session.id);
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
  open(provisioner?: UniplsProvisioner<TInput, TOutput>): Promise<void> {
    this.#ensureProvisioner(provisioner);

    // TODO: 初回の接続が即失敗したときには、デフォルトではリトライしない (polite option)
    return this.#socket.open(async () => this.#runProvisioner());
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

    const events = this.events.spawnEventBusView();
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
    data: UniplsMessageFactory<TInput>,
    params: UniplsRequestParams<TInput, TOutput>,
  ): Promise<TOutput> {
    return this.#request(data, { ...params, force: false });
  }

  /**
   * {@link Unipls.request|unipls.request()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  requestForce(
    data: UniplsMessageFactory<TInput>,
    params: UniplsRequestParams<TInput, TOutput>,
  ): Promise<TOutput> {
    return this.#request(data, { ...params, force: true });
  }

  #request(
    data: UniplsMessageFactory<TInput>,
    params: UniplsRequestParams<TInput, TOutput> & { force: boolean },
  ): Promise<TOutput> {
    if (this.state === 'closed') {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const events = this.events.spawnEventBusView();
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
      payload: UniplsMessageFactory<TInput>,
      { selector }: { selector: (data: TOutput) => boolean },
    ) => {
      if (result.resulted) {
        return;
      }

      const evaluatedPayload = Unipls.#evaluatePayload(payload);

      this.#socket
        .enqueue(evaluatedPayload, {
          force: params.force,
          signal: result.signal,
        })
        .then(() => {
          activeRequest = payload;
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

    let retryRegistered = false;

    const onReconnected: UniplsRetrySetupContext<
      TInput,
      TOutput
    >['onReconnected'] = (callback) => {
      events.once('reconnect', (reconnection) => {
        if (result.resulted) {
          return;
        }

        callback({
          request,
          done: () => {
            // no-op: provided for symmetry with other retry contexts
          },
          reconnection,
        });
      });
    };

    events.on('dropped', () => {
      if (result.resulted || retryRegistered) {
        return;
      }
      retryRegistered = true;

      const setupRetry = Unipls.getRetrySetupFunction(params.retry);
      setupRetry({
        onReconnected,
        data: activeRequest,
        selector: activeSelector,
        abort: (error) => {
          result.reject(error ?? new UniplsDroppedError());
        },
      });
    });

    return result.promise;
  }

  #runProvisioner(): Promise<void> {
    const result = new AsyncResult<void>();
    const provision = this.#provisioner ?? (({ done }) => done());
    const sessionId = this.#socket.sessionId;
    const isSessionBeginning = !this.#provisionedSessions.has(sessionId);

    this.#provisionedSessions.add(sessionId);

    const ctx: UniplsProvisioningContext<TInput, TOutput> = {
      cast: (data) => this.castForce(data),
      request: (data, params) => this.requestForce(data, params),
      listen: (params) => this.listen(params),
      subscribe: (data, params) => this.subscribeForce(data, params),
      done: result.resolve,
      session: sessionId,
      isSessionBeginning,
    };

    try {
      provision(ctx);
    } catch (err) {
      result.reject(err);
    }

    return result.promise;
  }

  #ensureProvisioner(provisioner?: UniplsProvisioner<TInput, TOutput>): void {
    if (provisioner) {
      this.#provisioner = provisioner;
    }

    if (!this.#provisioner) {
      this.#provisioner = ({ done }) => done();
    }
  }

  #handleDropped(sessionId: number): void {
    if (this.intent === 'close') {
      return;
    }

    if (sessionId !== this.#socket.sessionId) {
      return;
    }

    if (this.#reconnectPromise) {
      return;
    }

    this.#ensureProvisioner();
    const previousSessionId = this.#socket.sessionId;

    this.#reconnectPromise = this.#socket
      .open(async () => this.#runProvisioner())
      .then(() => {
        this.events.emit('reconnect', {
          previousSessionId,
          sessionId: this.#socket.sessionId,
        });
      })
      .catch((err) => {
        console.warn('Reconnection attempt failed:', err);
      })
      .finally(() => {
        this.#reconnectPromise = undefined;
      });
  }

  /**
   * 1-input N-output の通信を行います。{@link UniplsProvisioner} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns 購読を解除する関数を返します
   *
   * @throws {UniplsClosedError}
   */
  subscribe(
    data: UniplsMessageFactory<TInput>,
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
    data: UniplsMessageFactory<TInput>,
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    void data;
    void params;
    throw new NotImplementedError();
  }

  protected static getRetrySetupFunction<TInput, TOutput>(
    retry?: UniplsRetryStrategy<TInput, TOutput>,
  ): UniplsRetrySetupFunction<TInput, TOutput> {
    if (retry === undefined || retry === 'never') {
      return ({ abort }) => {
        abort();
      };
    }

    if (retry === 're-request') {
      return ({ onReconnected, data, selector, abort }) => {
        onReconnected(({ request, done }) => {
          try {
            request(data, { selector });
            done?.();
          } catch (err) {
            abort(err);
          }
        });
      };
    }

    if (retry === 'keep-listening') {
      return ({ onReconnected }) => {
        onReconnected(({ done }) => {
          done?.();
        });
      };
    }

    return retry;
  }

  static #evaluatePayload<TInput>(
    payload: UniplsMessageFactory<TInput>,
  ): TInput {
    if (typeof payload === 'function') {
      return (payload as () => TInput)();
    }
    return payload;
  }

  static #processMessage<TOutput>({
    message,
    selector,
    onSelected,
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
        onSelected?.(message);
      } catch (err) {
        onProcessorError?.(err);
      }
    }
  }
}
