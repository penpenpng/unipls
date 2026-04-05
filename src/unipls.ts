import { AsyncResult } from './async-result.ts';
import { AsyncResults, type UniplsSubscriber } from './async-results.ts';
import type { DropDetectorContext } from './drop-detector';
import { DropDetectorManager } from './drop-detector/drop-detector-manager.ts';
import { UniplsClosedError, UniplsDroppedError } from './errors.ts';
import type { EventBus } from './event-bus';
import type {
  UniplsReconnectEvent,
  UniplsReconnector,
} from './reconnector/reconnector.ts';
import type { UniplsConnectionState, WebSocketData } from './types.ts';
import { UniplsSessionManager } from './unipls-session.ts';
import { UniplsSocket, type UniplsSocketPublicEvents } from './unipls-socket';
import type {
  UniplsCastParams,
  UniplsListenOptions,
  UniplsMessageFactory,
  UniplsNextParams,
  UniplsParams,
  UniplsProvisioner,
  UniplsProvisioningContext,
  UniplsRequestParams,
  UniplsRetrySetupContext,
  UniplsRetrySetupFunction,
  UniplsRetryStrategy,
  UniplsSubscribeParams,
} from './unipls.interface.ts';

type UniplsEvents<TOutput> = UniplsSocketPublicEvents<TOutput> & {
  reconnect: UniplsReconnectEvent;
};

export class Unipls<TInput = WebSocketData, TOutput = WebSocketData> {
  #socket: UniplsSocket<TInput, TOutput>;
  #provisioner?: UniplsProvisioner<TInput, TOutput>;
  #provisionedSessions = new Set<number>();
  #reconnector?: UniplsReconnector;
  #session = new UniplsSessionManager();
  #detectorManager: DropDetectorManager<TInput, TOutput>;
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
    this.#reconnector = params.reconnector;
    this.#detectorManager = new DropDetectorManager(params.dropDetectors ?? []);

    this.events.on('dropped', ({ session }) => {
      this.#detectorManager.stop();
      void this.#handleDropped(session.id);
    });
  }

  /**
   * WebSocket 接続を確立します。
   *
   * @param {UniplsProvisioner} provisioner WebSocket 接続成功後の初期化処理を定義します。
   * @returns {Promise<void>} WebSocket 接続と初期化が完了したことを表す Promise を返します。
   *
   * @throws {UniplsDuplicatedConnectionError} WebSocket が既に接続されているか、接続を試行中の場合に例外を投げます。
   */
  open(provisioner?: UniplsProvisioner<TInput, TOutput>): Promise<void> {
    this.#provisioner = provisioner;
    this.#session.new();

    // TODO: 初回の接続が即失敗したときには、デフォルトではリトライしない (polite option)
    return this.#socket.open(async () => {
      await this.#runProvisioner();
      this.#detectorManager.start(this.#createDropDetectorContext());
    });
  }

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    this.#session.abort();
    this.#detectorManager.stop();
    return this.#socket.close();
  }

  async [Symbol.asyncDispose]() {
    await this.close();
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

    events.on('message', ({ message }) => {
      Unipls.#processMessage({
        message,
        selector: params.selector,
        onSelected: result.resolve,
        onSelectorError: result.reject,
        onProcessorError: () => {
          // ignore because `result.resolve` never throws
        },
      });
    });

    events.on('dropped', () => {
      result.reject(new UniplsDroppedError());
    });

    events.once('closed', () => {
      result.reject(new UniplsClosedError());
    });

    return result.promise;
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
      results.raiseFatalError(new UniplsDroppedError());
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
  cast(params: UniplsCastParams<TInput>): Promise<void> {
    return this.#cast(params, false);
  }

  /**
   * {@link Unipls.cast|unipls.cast()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  castForce(params: UniplsCastParams<TInput>): Promise<void> {
    return this.#cast(params, true);
  }

  /**
   * 1-input 1-output の通信を行います。{@link UniplsProvisioner} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {Promise<T>} レスポンスを観測したときに resolve される Promise を返します。
   *
   * @throws {UniplsClosedError}
   * @throws {UniplsTimeoutError}
   */
  request(params: UniplsRequestParams<TInput, TOutput>): Promise<TOutput> {
    return this.#request({ ...params, force: false });
  }

  /**
   * {@link Unipls.request|unipls.request()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  requestForce(params: UniplsRequestParams<TInput, TOutput>): Promise<TOutput> {
    return this.#request({ ...params, force: true });
  }

  #request(
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
    let activeRequest = params.query;
    let activeSelector = params.selector;

    const request = (
      query: UniplsMessageFactory<TInput>,
      { selector }: { selector: (data: TOutput) => boolean },
    ) => {
      if (result.resulted) {
        return;
      }

      const evaluatedPayload = Unipls.#evaluateQuery(query);

      this.#socket
        .enqueue(evaluatedPayload, {
          force: params.force,
          signal: result.signal,
        })
        .then(() => {
          activeRequest = query;
          activeSelector = selector;
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
      request(params.query, params);
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
      events.once('reconnect', async (reconnection) => {
        if (result.resulted) {
          return;
        }

        try {
          await callback({
            request,
            reconnection,
          });
        } catch (err) {
          result.reject(err ?? new UniplsDroppedError());
        }
      });
    };

    events.on('dropped', () => {
      if (result.resulted || retryRegistered) {
        return;
      }
      retryRegistered = true;

      const setupRetry = Unipls.getRetrySetupFunction(params.retry);

      try {
        setupRetry({
          onReconnected,
          data: activeRequest,
          selector: activeSelector,
        });
      } catch (err) {
        result.reject(err ?? new UniplsDroppedError());
      }
    });

    events.once('closed', () => {
      result.reject(new UniplsClosedError());
    });

    return result.promise;
  }

  #cast(params: UniplsCastParams<TInput>, force: boolean): Promise<void> {
    if (this.state === 'closed') {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const events = this.events.spawnEventBusView();
    const result = new AsyncResult<void>({
      finally: () => {
        events.dispose();
      },
      signal: params.signal,
    });

    const sendOnce = (payload: TInput) => {
      if (result.resulted) return;
      this.#socket
        .enqueue(payload, { force, signal: result.signal })
        .then(() => result.resolve())
        .catch(() => {
          // Handled by event listeners below
        });
    };

    if (
      this.state === 'connecting' ||
      this.state === 'provisioning' ||
      this.state === 'open'
    ) {
      sendOnce(Unipls.#evaluateQuery(params.query));
    }

    events.once('closed', () => {
      result.reject(new UniplsClosedError());
    });

    return result.promise;
  }

  async #runProvisioner(): Promise<void> {
    const result = new AsyncResult<void>();
    const sessionId = this.#socket.sessionId;
    const isSessionBeginning = !this.#provisionedSessions.has(sessionId);

    this.#provisionedSessions.add(sessionId);

    const ctx: UniplsProvisioningContext<TInput, TOutput> = {
      cast: (data) => this.castForce(data),
      request: (params) => this.requestForce(params),
      listen: (params) => this.listen(params),
      subscribe: (params) => this.subscribeForce(params),
      session: sessionId,
      isSessionBeginning,
    };

    try {
      if (!this.#provisioner) {
        // do nothing
      } else if ('setup' in this.#provisioner) {
        await this.#provisioner.setup(ctx);
      } else {
        await this.#provisioner(ctx);
      }

      result.resolve();
    } catch (err) {
      result.reject(err);
    }

    return result.promise;
  }

  #createDropDetectorContext(): DropDetectorContext<TInput, TOutput> {
    return {
      drop: () => this.drop(),
      request: (params) => this.request(params),
    };
  }

  async #handleDropped(sessionId: number): Promise<void> {
    if (
      this.intent === 'close' ||
      sessionId !== this.#socket.sessionId ||
      !this.#reconnector
    ) {
      return;
    }

    const reconnect = async () => {
      if (this.intent === 'close') {
        return;
      }

      this.#session.recordAttempt();

      try {
        await this.#socket.open(async () => {
          await this.#runProvisioner();
          this.#detectorManager.start(this.#createDropDetectorContext());
        });

        const event = this.#session.onSuccess();
        this.events.emit('reconnect', event);
      } catch (err) {
        this.#session.onFailure(err);
      }
    };

    try {
      const cleanup = this.#reconnector.setup(
        {
          reconnect,
          cancel: () => {
            // TODO
          },
        },
        this.#session.buildContext(),
      );

      // TODO:
      // cleanup?.();
    } catch {
      return;
    }
  }

  /**
   * 1-input N-output の通信を行います。{@link UniplsProvisioner} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns 購読を解除する関数を返します
   *
   * @throws {UniplsClosedError}
   */
  subscribe(
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    return this.#subscribe(params, false);
  }

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  subscribeForce(
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    return this.#subscribe(params, true);
  }

  #subscribe(
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
    force: boolean,
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

    let activeRequest = params.query;
    let activeSelector = params.selector;

    const request = (
      query: UniplsMessageFactory<TInput>,
      { selector }: { selector: (data: TOutput) => boolean },
    ) => {
      if (results.resulted) {
        return;
      }

      const evaluatedPayload = Unipls.#evaluateQuery(query);

      this.#socket
        .enqueue(evaluatedPayload, {
          force,
          signal: results.signal,
        })
        .then(() => {
          activeRequest = query;
          activeSelector = selector;
        })
        .catch((err) => {
          if (err instanceof UniplsClosedError) {
            results.raiseFatalError(err);
          }
        });
    };

    if (
      this.state === 'connecting' ||
      this.state === 'provisioning' ||
      this.state === 'open'
    ) {
      request(params.query, params);
    }

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
        selector: activeSelector,
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

    const onReconnected: UniplsRetrySetupContext<
      TInput,
      TOutput
    >['onReconnected'] = (callback) => {
      events.once('reconnect', async (reconnection) => {
        if (results.resulted) {
          return;
        }

        try {
          await callback({
            request,
            reconnection,
          });
        } catch (err) {
          results.raiseFatalError(err ?? new UniplsDroppedError());
        }
      });
    };

    let retryRegistered = false;

    events.on('dropped', () => {
      if (results.resulted || retryRegistered) {
        return;
      }
      retryRegistered = true;

      const setupRetry = Unipls.getRetrySetupFunction(params.retry);

      try {
        setupRetry({
          onReconnected,
          data: activeRequest,
          selector: activeSelector,
        });
      } catch (err) {
        results.raiseFatalError(err ?? new UniplsDroppedError());
      }
    });

    events.once('closed', () => {
      results.raiseFatalError(new UniplsClosedError());
    });

    return results.unsubscribe;
  }

  protected static getRetrySetupFunction<TInput, TOutput>(
    retry?: UniplsRetryStrategy<TInput, TOutput>,
  ): UniplsRetrySetupFunction<TInput, TOutput> {
    if (retry === undefined || retry === 'never') {
      return () => {
        throw new UniplsDroppedError();
      };
    }

    if (retry === 're-request') {
      return ({ onReconnected, data, selector }) => {
        onReconnected(async ({ request }) => {
          await request(data, { selector });
        });
      };
    }

    if (retry === 'keep-listening') {
      return ({ onReconnected }) => {
        onReconnected(() => {});
      };
    }

    return retry;
  }

  static #evaluateQuery<TInput>(query: UniplsMessageFactory<TInput>): TInput {
    if (typeof query === 'function') {
      return (query as () => TInput)();
    }
    return query;
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
