import { AsyncResult } from "./async-result.ts";
import type { UniplsSubscriber } from "./async-results.ts";
import type { DropDetectorContext } from "./drop-detector";
import { DropDetectorManager } from "./drop-detector/drop-detector-manager.ts";
import {
  UniplsClosedError,
  UniplsDroppedError,
  UniplsDuplicatedConnectionError,
  UniplsOpenError,
  UniplsSocketClosedError,
  UniplsSocketDroppedError,
  UniplsTimeoutError,
} from "./errors.ts";
import { EventBus } from "./event-bus";
import { UniplsLifecycleCoordinator } from "./lifecycle.ts";
import { createDropWaitHandler, createRetryingDropHandler } from "./operations/drop-policy.ts";
import { SingleOperationScope, StreamOperationScope } from "./operations/operation-scope.ts";
import { QuerySession } from "./operations/query-session.ts";
import { createOnReconnectedHandler } from "./operations/reconnect-hook.ts";
import type { UniplsReconnectEvent, UniplsReconnector } from "./reconnector/reconnector.ts";
import type {
  ConnectionId,
  SessionId,
  UniplsConnectionState,
  UniplsDrop,
  UniplsLifecycleSnapshot,
  WebSocketData,
} from "./types.ts";
import { UniplsSocket } from "./unipls-socket";
import type {
  UniplsCastParams,
  UniplsListenOptions,
  UniplsMessageFactory,
  UniplsNextParams,
  UniplsParams,
  UniplsProvisioner,
  UniplsProvisioningContext,
  UniplsRequestParams,
  UniplsSubscribeParams,
} from "./unipls.interface.ts";

interface ConnectionEventContext {
  readonly session: SessionId;
  readonly connection: ConnectionId;
}

type UniplsEvents<TOutput> = {
  open: ConnectionEventContext;
  message: ConnectionEventContext & { message: TOutput };
  error: ConnectionEventContext & { error: unknown };
  closed: ConnectionEventContext;
  dropped: ConnectionEventContext & { code?: number; drop?: UniplsDrop };
  failed: ConnectionEventContext & { error: unknown };
  lifecycle: {
    previous: UniplsLifecycleSnapshot;
    current: UniplsLifecycleSnapshot;
  };
  reconnect: UniplsReconnectEvent;
};

export class Unipls<TInput = WebSocketData, TOutput = WebSocketData> {
  #socket: UniplsSocket<TInput, TOutput>;
  #events = new EventBus<UniplsEvents<TOutput>>();
  #transportContexts = new Map<number, ConnectionEventContext>();
  #provisioner?: UniplsProvisioner<TInput, TOutput>;
  #reconnector?: UniplsReconnector;
  #reconnectorCleanup?: () => void;
  #lifecycle: UniplsLifecycleCoordinator;
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
  get lifecycle(): UniplsLifecycleSnapshot {
    return this.#lifecycle.snapshot;
  }
  protected get events(): EventBus<UniplsEvents<TOutput>> {
    return this.#events;
  }
  get on() {
    return this.events.on.bind(this.events);
  }
  get off() {
    return this.events.off.bind(this.events);
  }

  constructor(params: UniplsParams<TInput, TOutput>) {
    this.#socket = new UniplsSocket(params);
    this.#lifecycle = new UniplsLifecycleCoordinator((event) => {
      this.events.emit("lifecycle", event);
    });
    this.#reconnector = params.reconnector;
    this.#detectorManager = new DropDetectorManager(params.dropDetectors ?? []);
    this.#bridgeSocketEvents();
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
    if (this.#lifecycle.hasActiveSession) {
      throw new UniplsDuplicatedConnectionError();
    }

    this.#provisioner = provisioner;
    const connection = this.#lifecycle.beginSession();

    let transportEpochId = Number.NaN;
    let transportSignal: AbortSignal | undefined;
    const socketOpening = this.#socket.open(async (signal) => {
      transportSignal = signal;
      this.#assertCurrentTransport(transportEpochId, signal);
      this.#lifecycle.markProvisioning(connection);
      await this.#runProvisioner(transportEpochId, signal);
      this.#assertCurrentTransport(transportEpochId, signal);
      this.#detectorManager.start(
        transportEpochId,
        this.#createDropDetectorContext(transportEpochId, signal),
      );
    });
    transportEpochId = this.#socket.transportEpochId;
    this.#bindTransport(transportEpochId, connection);
    const promise = socketOpening
      .then(() => {
        this.#assertCurrentTransport(transportEpochId, transportSignal);
        if (!this.#lifecycle.isCurrentAttempt(connection)) {
          throw transportSignal?.reason ?? new UniplsSocketDroppedError();
        }
        this.#lifecycle.markReady(connection);
        this.events.emit("open", {
          session: this.#lifecycle.session,
          connection,
        });
      })
      .catch((error) => {
        const cause = Unipls.#translateSocketError(error);
        if (!this.#lifecycle.isCurrentAttempt(connection)) {
          throw cause;
        }
        const stage = this.lifecycle.phase === "provisioning" ? "provisioning" : "connecting";
        const attempts = this.#lifecycle.failInitialAttempt(connection, cause);
        throw new UniplsOpenError({
          outcome: "attempt-failed",
          stage,
          attempts,
          cause,
        });
      });
    void promise.catch(() => {});
    return promise;
  }

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    this.#lifecycle.closeByUser();
    this.#detectorManager.stop();
    this.#reconnectorCleanup?.();
    this.#reconnectorCleanup = undefined;
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
    if (this.state === "closed") {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const scope = new SingleOperationScope<TOutput, UniplsEvents<TOutput>>({
      events: this.events,
      signal: params.signal,
      timeout: params.timeout,
    });
    const { events } = scope;

    events.on("message", ({ message }) => {
      Unipls.#processMessage({
        message,
        selector: params.selector,
        onSelected: scope.resolve,
        onSelectorError: scope.reject,
        onProcessorError: () => {
          // ignore because `scope.resolve` never throws
        },
      });
    });
    events.on("error", ({ error }) => {
      scope.reject(error);
    });

    events.on(
      "dropped",
      createDropWaitHandler({
        reconnectable: this.#reconnector !== undefined,
        retry: params.retry,
        isDone: () => scope.resulted,
        onFatal: scope.reject,
      }),
    );

    events.once("closed", () => {
      scope.reject(new UniplsClosedError());
    });

    return scope.promise;
  }

  /**
   * 0-input N-output の通信を行います。
   *
   * @returns 購読を解除する関数を返します。
   *
   * @throws {UniplsClosedError}
   */
  listen(params: UniplsSubscriber<TOutput> & UniplsListenOptions<TOutput>): () => void {
    if (this.state === "closed") {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const scope = new StreamOperationScope<TOutput, UniplsEvents<TOutput>>({
      events: this.events,
      subscriber: params,
      signal: params.signal,
    });
    const { events } = scope;

    events.on("message", ({ message }) => {
      Unipls.#processMessage({
        message,
        selector: params.terminator ?? (() => false),
        onSelected: scope.handleTerminator,
        onSelectorError: scope.handleError,
        onProcessorError: (err) => {
          console.warn("An error occurred while processing onTerminator callback:", err);
        },
      });
      Unipls.#processMessage({
        message,
        selector: params.selector ?? (() => true),
        onSelected: scope.handleMessage,
        onSelectorError: scope.handleError,
        onProcessorError: (err) => {
          console.warn("An error occurred while processing onMessage callback:", err);
        },
      });
    });
    events.on("error", ({ error }) => {
      scope.handleError(error);
    });

    events.on(
      "dropped",
      createDropWaitHandler({
        reconnectable: this.#reconnector !== undefined,
        retry: params.retry,
        isDone: () => scope.resulted,
        onFatal: scope.raiseFatalError,
      }),
    );
    events.once("closed", () => {
      scope.raiseFatalError(new UniplsClosedError());
    });

    return scope.unsubscribe;
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

  #request(params: UniplsRequestParams<TInput, TOutput> & { force: boolean }): Promise<TOutput> {
    if (this.state === "closed") {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const scope = new SingleOperationScope<TOutput, UniplsEvents<TOutput>>({
      events: this.events,
      signal: params.signal,
      timeout: params.timeout,
    });
    const { events } = scope;
    const requestSession = new QuerySession<TInput, TOutput>({
      query: params.query,
      selector: params.selector,
      evaluate: Unipls.#evaluateQuery,
      sendPayload: (payload) =>
        this.#socket.enqueue(payload, {
          force: params.force,
          signal: scope.signal,
        }),
      onError: (error) => scope.reject(Unipls.#translateSocketError(error)),
    });

    const request = (
      query: UniplsMessageFactory<TInput>,
      { selector }: { selector: (data: TOutput) => boolean },
    ) => {
      requestSession.send(query, {
        selector,
        isDone: () => scope.resulted,
      });
    };

    if (this.state === "connecting" || this.state === "provisioning" || this.state === "open") {
      request(params.query, params);
    }

    events.on("message", ({ message }) => {
      if (!requestSession.sent) {
        return;
      }

      Unipls.#processMessage({
        message,
        selector: requestSession.currentSelector,
        onSelected: scope.resolve,
        onSelectorError: scope.reject,
        onProcessorError: () => {
          // ignore because `scope.resolve` never throws
        },
      });
    });
    events.on("error", ({ error }) => {
      scope.reject(error);
    });

    const onReconnected = createOnReconnectedHandler({
      events,
      isDone: () => scope.resulted,
      reset: () => requestSession.resetForReconnect(),
      request,
      onError: scope.reject,
    });

    events.on(
      "dropped",
      createRetryingDropHandler({
        reconnectable: this.#reconnector !== undefined,
        retry: params.retry,
        isDone: () => scope.resulted,
        onFatal: scope.reject,
        onReconnected,
        getQuery: () => requestSession.currentQuery,
        getSelector: () => requestSession.currentSelector,
      }),
    );

    events.once("closed", () => {
      scope.reject(new UniplsClosedError());
    });

    return scope.promise;
  }

  #cast(params: UniplsCastParams<TInput>, force: boolean): Promise<void> {
    if (this.state === "closed") {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    const scope = new SingleOperationScope<void, UniplsEvents<TOutput>>({
      events: this.events,
      signal: params.signal,
      timeout: params.timeout,
    });
    const { events } = scope;

    const sendOnce = (query: UniplsMessageFactory<TInput>) => {
      if (scope.resulted) return;

      const enqueueEvaluatedPayload = () => {
        const payload = Unipls.#evaluateQuery(query);
        this.#socket
          .enqueue(payload, { force, signal: scope.signal })
          .then(() => scope.resolve())
          .catch((error) => {
            scope.reject(Unipls.#translateSocketError(error));
          });
      };

      if (this.state === "open" || (this.state === "provisioning" && force)) {
        enqueueEvaluatedPayload();
        return;
      }

      if (force) {
        events.once("open", enqueueEvaluatedPayload);
      } else {
        events.once("open", enqueueEvaluatedPayload);
      }
    };

    if (this.state === "connecting" || this.state === "provisioning" || this.state === "open") {
      sendOnce(params.query);
    }

    events.once("closed", () => {
      scope.reject(new UniplsClosedError());
    });

    return scope.promise;
  }

  async #runProvisioner(transportEpochId: number, signal: AbortSignal): Promise<void> {
    const result = new AsyncResult<void>();
    const sessionId = this.#lifecycle.session;
    const isSessionBeginning = this.#lifecycle.isSessionBeginning;

    const ctx: UniplsProvisioningContext<TInput, TOutput> = {
      cast: (data) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        return this.castForce({ query: data, signal });
      },
      request: (params) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        return this.requestForce({ ...params, signal });
      },
      listen: (params) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        this.listen({ ...params, signal });
      },
      subscribe: (params) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        return this.subscribeForce({ ...params, signal });
      },
      session: sessionId,
      isSessionBeginning,
    };

    try {
      if (!this.#provisioner) {
        this.#lifecycle.markSessionSetupCompleted();
      } else if (typeof this.#provisioner === "function") {
        this.#lifecycle.markSessionSetupCompleted();
        await this.#waitForProvisioning(this.#provisioner(ctx), signal);
      } else {
        if (isSessionBeginning && this.#provisioner.setupSession) {
          await this.#waitForProvisioning(this.#provisioner.setupSession(ctx), signal);
          this.#assertCurrentTransport(transportEpochId, signal);
          this.#lifecycle.markSessionSetupCompleted();
        } else if (isSessionBeginning) {
          this.#lifecycle.markSessionSetupCompleted();
        }
        await this.#waitForProvisioning(this.#provisioner.setupConnection(ctx), signal);
      }

      this.#assertCurrentTransport(transportEpochId, signal);
      result.resolve();
    } catch (err) {
      result.reject(err);
    }

    return result.promise;
  }

  #createDropDetectorContext(
    transportEpochId: number,
    signal: AbortSignal,
  ): DropDetectorContext<TInput, TOutput> {
    return {
      drop: () => this.#socket.drop(transportEpochId),
      request: (params) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        return this.request({
          ...params,
          signal: AbortSignal.any([signal, ...(params.signal ? [params.signal] : [])]),
        });
      },
    };
  }

  #bindTransport(transportEpochId: number, connection: ConnectionId): void {
    this.#transportContexts.clear();
    this.#transportContexts.set(transportEpochId, {
      session: this.#lifecycle.session,
      connection,
    });
  }

  #bridgeSocketEvents(): void {
    this.#socket.events.on("message", ({ epoch, message }) => {
      const context = this.#currentTransportContext(epoch.id);
      if (context) {
        this.events.emit("message", { ...context, message });
      }
    });
    this.#socket.events.on("error", ({ epoch, error }) => {
      const context = this.#currentTransportContext(epoch.id);
      if (context) {
        this.events.emit("error", { ...context, error });
      }
    });
    this.#socket.events.on("failed", ({ epoch, error }) => {
      const context = this.#currentTransportContext(epoch.id);
      if (context) {
        this.events.emit("failed", { ...context, error });
      }
    });
    this.#socket.events.on("closed", ({ epoch }) => {
      const context = this.#currentTransportContext(epoch.id);
      if (context) {
        this.#detectorManager.stop(epoch.id);
        this.events.emit("closed", context);
        this.#transportContexts.delete(epoch.id);
      }
    });
    this.#socket.events.on("dropped", ({ epoch, code }) => {
      const context = this.#currentTransportContext(epoch.id);
      if (!context) {
        return;
      }

      this.#detectorManager.stop(epoch.id);
      let drop: UniplsDrop | undefined;
      if (this.#lifecycle.hasActiveSession && this.#lifecycle.hasBeenReady) {
        drop = this.#lifecycle.createPeerDrop(code);
        this.#lifecycle.beginRecovery(drop);
      }
      this.events.emit("dropped", {
        ...context,
        code,
        ...(drop ? { drop } : {}),
      });
      if (drop) {
        void this.#handleDropped(epoch.id);
      }
      this.#transportContexts.delete(epoch.id);
    });
  }

  async #handleDropped(epochId: number): Promise<void> {
    if (
      this.intent === "close" ||
      epochId !== this.#socket.transportEpochId ||
      !this.#reconnector
    ) {
      return;
    }

    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      this.#reconnectorCleanup = undefined;
      registeredCleanup?.();
    };

    const reconnect = async () => {
      if (settled || this.intent === "close") {
        return;
      }
      cleanup();

      this.#lifecycle.recordReconnectAttempt();
      const connection = this.#lifecycle.beginRecoveryAttempt();

      try {
        let transportEpochId = Number.NaN;
        let transportSignal: AbortSignal | undefined;
        const socketOpening = this.#socket.open(async (signal) => {
          transportSignal = signal;
          this.#assertCurrentTransport(transportEpochId, signal);
          this.#lifecycle.markProvisioning(connection);
          await this.#runProvisioner(transportEpochId, signal);
          this.#assertCurrentTransport(transportEpochId, signal);
          this.#detectorManager.start(
            transportEpochId,
            this.#createDropDetectorContext(transportEpochId, signal),
          );
        });
        transportEpochId = this.#socket.transportEpochId;
        this.#bindTransport(transportEpochId, connection);
        await socketOpening;
        this.#assertCurrentTransport(transportEpochId, transportSignal);
        if (!this.#lifecycle.isCurrentAttempt(connection)) {
          throw transportSignal?.reason ?? new UniplsSocketDroppedError();
        }

        this.#lifecycle.markReady(connection);
        this.events.emit("open", {
          session: this.#lifecycle.session,
          connection,
        });
        const event = this.#lifecycle.reconnectSucceeded();
        this.events.emit("reconnect", event);
      } catch (err) {
        const cause = Unipls.#translateSocketError(err);
        if (this.#lifecycle.isCurrentAttempt(connection)) {
          this.#lifecycle.failRecoveryAttempt(connection, cause);
          this.#lifecycle.reconnectFailed(cause);
        }
      }
    };

    const cancel = () => {
      if (settled) {
        return;
      }
      cleanup();
    };

    let registeredCleanup: (() => void) | undefined;

    try {
      const cleanupCallback = this.#reconnector.setup(
        {
          reconnect,
          cancel,
        },
        this.#lifecycle.buildReconnectionContext(),
      );
      registeredCleanup = cleanupCallback ?? undefined;
      this.#reconnectorCleanup = cleanup;
    } catch {
      cleanup();
      return;
    }
  }

  #currentTransportContext(transportEpochId: number): ConnectionEventContext | undefined {
    if (!this.#socket.isCurrentTransportEpoch(transportEpochId)) {
      return undefined;
    }
    return this.#transportContexts.get(transportEpochId);
  }

  #assertCurrentTransport(transportEpochId: number, signal?: AbortSignal): void {
    if (signal?.aborted || !this.#socket.isCurrentTransportEpoch(transportEpochId)) {
      throw signal?.reason ?? new UniplsSocketDroppedError();
    }
  }

  #waitForProvisioning<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(value).then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
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
    if (this.state === "closed") {
      throw new UniplsClosedError();
    }
    if (params.signal?.aborted) {
      throw params.signal.reason;
    }

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const scope = new StreamOperationScope<TOutput, UniplsEvents<TOutput>>({
      events: this.events,
      subscriber: params,
      signal: params.signal,
      finally: () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
      },
    });
    const { events } = scope;

    const requestSession = new QuerySession<TInput, TOutput>({
      query: params.query,
      selector: params.selector,
      evaluate: Unipls.#evaluateQuery,
      sendPayload: (payload) =>
        this.#socket.enqueue(payload, {
          force,
          signal: scope.signal,
        }),
      onError: (error) => scope.raiseFatalError(Unipls.#translateSocketError(error)),
    });

    const request = (
      query: UniplsMessageFactory<TInput>,
      { selector }: { selector: (data: TOutput) => boolean },
    ) => {
      requestSession.send(query, {
        selector,
        isDone: () => scope.resulted,
      });
    };

    if (this.state === "connecting" || this.state === "provisioning" || this.state === "open") {
      request(params.query, params);
    }

    if (typeof params.timeout === "number" && params.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        scope.raiseFatalError(new UniplsTimeoutError());
        timeoutTimer = undefined;
      }, params.timeout);
    }

    events.on("message", ({ message }) => {
      if (!requestSession.sent) {
        return;
      }

      Unipls.#processMessage({
        message,
        selector: params.terminator ?? (() => false),
        onSelected: scope.handleTerminator,
        onSelectorError: scope.handleError,
        onProcessorError: (err) => {
          console.warn("An error occurred while processing onTerminator callback:", err);
        },
      });
      Unipls.#processMessage({
        message,
        selector: requestSession.currentSelector,
        onSelected: scope.handleMessage,
        onSelectorError: scope.handleError,
        onProcessorError: (err) => {
          console.warn("An error occurred while processing onMessage callback:", err);
        },
      });
    });
    events.on("error", ({ error }) => {
      scope.handleError(error);
    });

    const onReconnected = createOnReconnectedHandler({
      events,
      isDone: () => scope.resulted,
      reset: () => requestSession.resetForReconnect(),
      request,
      onError: scope.raiseFatalError,
    });

    events.on(
      "dropped",
      createRetryingDropHandler({
        reconnectable: this.#reconnector !== undefined,
        retry: params.retry,
        isDone: () => scope.resulted,
        onFatal: scope.raiseFatalError,
        onReconnected,
        getQuery: () => requestSession.currentQuery,
        getSelector: () => requestSession.currentSelector,
      }),
    );

    events.once("closed", () => {
      scope.raiseFatalError(new UniplsClosedError());
    });

    return scope.unsubscribe;
  }

  static #evaluateQuery<TInput>(query: UniplsMessageFactory<TInput>): TInput {
    if (typeof query === "function") {
      return (query as () => TInput)();
    }
    return query;
  }

  static #translateSocketError(error: unknown): unknown {
    if (error instanceof UniplsSocketClosedError) {
      return new UniplsClosedError();
    }
    if (error instanceof UniplsSocketDroppedError) {
      return new UniplsDroppedError();
    }
    return error;
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
