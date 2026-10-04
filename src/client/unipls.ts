import { DropDetectorManager } from "../drop-detectors/drop-detector-manager.ts";
import type {
  DropDetectorContext,
  DropDetectorRequestParams,
} from "../drop-detectors/drop-detector.ts";
import {
  normalizeStreamBuffer,
  type AsyncSubscription,
  type StreamCallbackErrorPolicy,
  type StreamFinalization,
  type SubscriptionHandle,
} from "../operations/async-results.ts";
import { createDropWaitHandler, createRetryingDropHandler } from "../operations/drop-policy.ts";
import { MessageDispatcher, type MessageDeliveryMode } from "../operations/message-dispatcher.ts";
import {
  validateDropRetryStrategy,
  validateOperationParams,
  validateOperationSignal,
  validateOptionalCallback,
  validatePredicateErrorPolicy,
  validateProvisioner,
  validateRequiredCallback,
  validateRequiredProperty,
  validateRetryStrategy,
  validateStreamDelivery,
} from "../operations/operation-input.ts";
import {
  SingleOperationScope,
  StreamOperationScope,
  validateOperationTimeout,
} from "../operations/operation-scope.ts";
import { QuerySession } from "../operations/query-session.ts";
import { createOnReconnectedHandler } from "../operations/reconnect-hook.ts";
import type {
  ReconnectionContext,
  UniplsReconnectEvent,
  UniplsReconnector,
} from "../reconnectors/reconnector.ts";
import {
  UniplsClosedError,
  UniplsDroppedError,
  UniplsInvalidUsageError,
  UniplsOpenError,
  UniplsSocketClosedError,
  UniplsSocketDroppedError,
} from "../shared/errors.ts";
import { EventBus } from "../shared/event-bus.ts";
import { OwnedResourceScope, type Disposer, type MaybePromise } from "../shared/resource-scope.ts";
import type { DropDetectorReport } from "../shared/types.ts";
import type {
  ConnectionId,
  DropDetectorIdentity,
  ReconnectionEngineOutcome,
  SessionId,
  UniplsLog,
  UniplsResourceScope,
  UniplsDrop,
  UniplsDroppedErrorOutcome,
  UniplsLifecycleSnapshot,
  PredicateErrorPolicy,
  WebSocketData,
} from "../shared/types.ts";
import { UniplsSocket, type UniplsSocketDropReport } from "../socket/unipls-socket.ts";
import { UniplsLifecycleCoordinator } from "./lifecycle.ts";
import type {
  ConnectionSetupContext,
  SessionSetupContext,
  UniplsCastParams,
  UniplsListenCallbackParams,
  UniplsListenIteratorParams,
  UniplsMessageFactory,
  UniplsNextParams,
  UniplsParams,
  UniplsProvisioner,
  UniplsRequestParams,
  UniplsSubscribeCallbackParams,
  UniplsSubscribeIteratorParams,
} from "./unipls.interface.ts";

/** 公開 event を発生させた論理セッションと接続を識別します。 */
export interface ConnectionEventContext {
  /** event が属する論理セッションです。 */
  readonly session: SessionId;
  /** event が属する WebSocket 接続試行です。 */
  readonly connection: ConnectionId;
}

interface PendingOpen {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  settled: boolean;
}

interface ReconnectionPolicyRun {
  readonly context: ReconnectionContext;
  settled: boolean;
  outcome?: ReconnectionEngineOutcome;
  cleanup?: () => void;
  cleanupCalled: boolean;
}

export type UniplsEvents<TOutput> = {
  /** 接続が ready になったときに通知されます。 */
  open: ConnectionEventContext;
  /** メッセージを受信して変換できたときに通知されます。 */
  message: ConnectionEventContext & { readonly message: TOutput };
  /** 論理セッションが終了したときに通知されます。 */
  closed: ConnectionEventContext & { readonly error?: UniplsOpenError | UniplsDroppedError };
  /** ready だった接続を失ったときに通知されます。 */
  dropped: ConnectionEventContext & {
    readonly drop: UniplsDrop;
    readonly error: UniplsDroppedError;
  };
  /** 接続の初期化処理が失敗したときに通知されます。 */
  failed: ConnectionEventContext & { readonly error: unknown };
  /** 論理セッションの lifecycle が遷移したときに通知されます。 */
  lifecycle: {
    readonly previous: UniplsLifecycleSnapshot;
    readonly current: UniplsLifecycleSnapshot;
  };
  /** 接続回復が成功したときに通知されます。 */
  reconnect: UniplsReconnectEvent;
};

/** 論理セッションを維持しながら WebSocket の送受信と回復を管理する client です。 */
export class Unipls<TInput = WebSocketData, TOutput = WebSocketData> {
  #socket: UniplsSocket<TInput, TOutput>;
  #events = new EventBus<UniplsEvents<TOutput>>();
  #messages = new MessageDispatcher<TOutput>();
  #transportContexts = new Map<number, ConnectionEventContext>();
  #canonicalDrops = new Map<number, UniplsDrop>();
  #provisioner?: UniplsProvisioner<TInput, TOutput>;
  #reconnector?: UniplsReconnector;
  #logSink?: (log: UniplsLog) => void;
  #pendingOpen?: PendingOpen;
  #reconnectionPolicy?: ReconnectionPolicyRun;
  #lifecycle: UniplsLifecycleCoordinator;
  #detectorManager: DropDetectorManager<TInput, TOutput>;
  #sessionScope?: OwnedResourceScope;
  #connectionScopes = new Map<number, OwnedResourceScope>();
  /** 接続先の WebSocket URL です。 */
  get url(): string {
    return this.#socket.url;
  }
  /** 論理セッションの現在状態を表す不変なスナップショットです。 */
  get lifecycle(): UniplsLifecycleSnapshot {
    return this.#lifecycle.snapshot;
  }
  /** 公開イベントの listener を登録します。 */
  on<K extends keyof UniplsEvents<TOutput>>(
    event: K,
    listener: (payload: UniplsEvents<TOutput>[K]) => void,
    options?: { readonly once?: boolean },
  ): () => void {
    return this.#events.on(event, listener, options);
  }
  /** 公開イベントの listener を解除します。 */
  off<K extends keyof UniplsEvents<TOutput>>(
    event: K,
    listener: (payload: UniplsEvents<TOutput>[K]) => void,
  ): void {
    this.#events.off(event, listener);
  }

  /** 接続先と通信方針を指定して client を作成します。 */
  constructor(params: UniplsParams<TInput, TOutput>) {
    this.#logSink = params.logSink;
    this.#socket = new UniplsSocket({
      ...params,
      logSink: (log) => this.#forwardSocketLog(log),
    });
    this.#lifecycle = new UniplsLifecycleCoordinator((event) => {
      this.#events.emit("lifecycle", event);
    });
    this.#reconnector = params.reconnector;
    this.#detectorManager = new DropDetectorManager(params.dropDetectors ?? []);
    this.#bridgeSocketEvents();
  }

  /**
   * WebSocket 接続を確立します。
   *
   * @param provisioner WebSocket 接続後、ready になる前に行う初期化処理です。
   * @returns WebSocket 接続と初期化が完了すると解決する Promise です。
   *
   * @throws {TypeError} provisionerが公開されたhook形式に一致しない場合に例外を投げます。
   * @throws {UniplsInvalidUsageError} 論理セッションが既に有効な場合に例外を投げます。
   */
  open(provisioner?: UniplsProvisioner<TInput, TOutput>): Promise<void> {
    validateProvisioner(provisioner);

    if (this.#lifecycle.hasActiveSession) {
      throw new UniplsInvalidUsageError("論理セッションは既に有効です。");
    }

    this.#provisioner = provisioner;
    const connection = this.#lifecycle.beginSession();

    this.#sessionScope = this.#createResourceScope(
      Object.freeze({ type: "session", session: this.#lifecycle.session }),
    );
    let resolve!: () => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });

    this.#pendingOpen = { promise, resolve, reject, settled: false };
    void promise.catch(() => {});
    this.#startAttempt(connection);

    return promise;
  }

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    const context = this.#activeSessionContext();
    const closedError = new UniplsClosedError();

    this.#transportContexts.clear();
    const closing = this.#socket.close();

    this.#settlePolicy("session-closed");
    this.#lifecycle.closeByUser(closedError);
    this.#canonicalDrops.clear();
    const connectionScopes = [...this.#connectionScopes.values()];

    this.#connectionScopes.clear();
    const sessionScope = this.#sessionScope;

    this.#sessionScope = undefined;

    return (async () => {
      for (const scope of connectionScopes) {
        await scope.dispose(closedError);
      }

      await sessionScope?.dispose(closedError);
      this.#rejectPendingOpen(closedError);

      if (context) {
        this.#events.emit("closed", context);
      }

      await closing;
    })();
  }

  /** 現在の接続を手動で drop として報告します。 */
  drop(): void {
    return this.#socket.drop();
  }

  /**
   * selector に最初に一致する受信メッセージを待ちます。
   *
   * @returns 一致するメッセージで解決し、受付後に session が終了した場合や timeout、中断時にはその理由で reject する Promise です。
   * @throws {TypeError} 必須のselectorまたはoptionの型が不正な場合に同期的に投げます。
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  next(params: UniplsNextParams<TOutput>): Promise<TOutput> {
    validateOperationParams(params, "next");
    const selector = params.selector;
    const signal = params.signal;
    const timeout = params.timeout;
    const retry = params.retry;
    const predicateError = params.predicateError ?? "continue";

    validateRequiredCallback(selector, "selector", "next");
    validateOperationSignal(signal);
    validateDropRetryStrategy(retry);
    validatePredicateErrorPolicy(params.predicateError);
    validateOperationTimeout(timeout);
    const session = this.#lifecycle.acceptOperation();

    let scope!: SingleOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>;

    scope = new SingleOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>({
      events: this.#events,
      dispatcher: this.#messages,
      session,
      operationType: "next",
      mode: { type: "ready" },
      receive: (message) => {
        this.#processMessage({
          scope,
          message,
          predicate: selector,
          predicateType: "selector",
          policy: predicateError,
          onSelected: scope.resolve,
          onPredicateFailure: scope.reject,
        });
      },
      signal,
      timeout,
    });
    const { events } = scope;

    events.on("dropped", (event) => {
      if (event.session !== scope.session) {
        return;
      }

      createDropWaitHandler({
        reconnectable: this.#reconnector !== undefined,
        retry,
        isDone: () => scope.resulted,
        onFatal: scope.reject,
      })(event);
    });

    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) {
        return;
      }

      scope.reject(error ?? new UniplsClosedError());
    });

    return scope.promise;
  }

  /**
   * selector に一致する受信メッセージを購読します。
   *
   * callback の `onMatch` を指定すると subscription handle、指定しない場合は single-consumer の AsyncSubscription を返します。
   * callback の戻り値や Promise は待機しないため、callback delivery は逐次実行を保証しません。
   *
   * @throws {TypeError} selector、terminator、delivery、policyの型が不正な場合に同期的に投げます。
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  listen(
    params: UniplsListenCallbackParams<TOutput>,
  ): SubscriptionHandle<StreamFinalization<TOutput>>;
  listen(params: UniplsListenIteratorParams<TOutput>): AsyncSubscription<TOutput>;
  listen(
    params: UniplsListenCallbackParams<TOutput> | UniplsListenIteratorParams<TOutput>,
  ): SubscriptionHandle<StreamFinalization<TOutput>> | AsyncSubscription<TOutput> {
    return this.#listen(params, { type: "ready" });
  }

  #listen(
    params: UniplsListenCallbackParams<TOutput> | UniplsListenIteratorParams<TOutput>,
    mode: MessageDeliveryMode,
  ): SubscriptionHandle<StreamFinalization<TOutput>> | AsyncSubscription<TOutput> {
    validateOperationParams(params, "listen");
    const selector = params.selector ?? (() => true);
    const terminator = params.terminator ?? (() => false);
    const signal = params.signal;
    const timeout = params.timeout;
    const retry = params.retry;
    const predicateError = params.predicateError ?? "continue";
    const callback = params.onMatch;

    validateOptionalCallback(params.selector, "selector", "listen");
    validateOptionalCallback(params.terminator, "terminator", "listen");
    validateOperationSignal(signal);
    validateDropRetryStrategy(retry);
    validatePredicateErrorPolicy(params.predicateError);
    validateStreamDelivery(params, "listen");
    const callbackError = params.callbackError ?? "continue";
    const buffer = callback === undefined ? normalizeStreamBuffer(params.buffer) : undefined;

    validateOperationTimeout(timeout);
    const session = this.#lifecycle.acceptOperation();

    let scope!: StreamOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>;

    scope = new StreamOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>({
      events: this.#events,
      dispatcher: this.#messages,
      session,
      operationType: "listen",
      mode,
      receive: (message) => {
        const terminatorResult = this.#processMessage({
          scope,
          message,
          predicate: terminator,
          predicateType: "terminator",
          policy: predicateError,
          onSelected: scope.handleTerminator,
          onPredicateFailure: scope.raiseFatalError,
        });

        if (terminatorResult !== "unmatched") {
          return;
        }

        this.#processMessage({
          scope,
          message,
          predicate: selector,
          predicateType: "selector",
          policy: predicateError,
          onSelected: scope.handleMessage,
          onPredicateFailure: scope.raiseFatalError,
        });
      },
      delivery:
        callback === undefined
          ? {
              type: "iterator",
              buffer: buffer as ReturnType<typeof normalizeStreamBuffer>,
              onMessageDropped: (strategy, capacity) => {
                this.#logStreamMessageDropped(scope, strategy, capacity);
              },
            }
          : {
              type: "callback",
              onMatch: callback,
              policy: callbackError as StreamCallbackErrorPolicy,
              onCallbackError: (cause, policy) => {
                if (policy === "unsubscribe") {
                  scope.failCallback(cause);
                }

                this.#logStreamCallbackFailure(scope, cause, policy);
              },
            },
      signal,
      timeout,
    });
    const { events } = scope;

    events.on("dropped", (event) => {
      if (event.session !== scope.session) {
        return;
      }

      createDropWaitHandler({
        reconnectable: this.#reconnector !== undefined,
        retry,
        isDone: () => scope.resulted,
        onFatal: scope.raiseFatalError,
      })(event);
    });
    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) {
        return;
      }
      if (error) {
        scope.raiseFatalError(error);
      } else {
        scope.close();
      }
    });

    return scope.handle;
  }

  /**
   * 1件のメッセージを送信します。初期化中の場合は ready になるまで送信を待ちます。
   *
   * @returns メッセージの送信が完了すると解決する Promise です。
   *
   * @throws {TypeError} 必須のqueryまたはoptionの型が不正な場合に同期的に投げます。
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  cast(params: UniplsCastParams<TInput>): Promise<void> {
    return this.#cast(params, { type: "ready" });
  }

  /**
   * 1件のメッセージを送信し、selector に最初に一致する応答を待ちます。初期化中の場合は ready になるまで送信を待ちます。
   *
   * @returns selector に一致するメッセージで解決する Promise です。
   *
   * @throws {TypeError} 必須のquery、selectorまたはoptionの型が不正な場合に同期的に投げます。
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  request(params: UniplsRequestParams<TInput, TOutput>): Promise<TOutput> {
    return this.#request(params, { type: "ready" });
  }

  #request(
    params: UniplsRequestParams<TInput, TOutput>,
    mode: MessageDeliveryMode,
  ): Promise<TOutput> {
    validateOperationParams(params, "request");
    validateRequiredProperty(params, "query", "request");
    const query = params.query;
    const selector = params.selector;
    const signal = params.signal;
    const timeout = params.timeout;
    const retry = params.retry;
    const predicateError = params.predicateError ?? "continue";

    validateRequiredCallback(selector, "selector", "request");
    validateOperationSignal(signal);
    validateRetryStrategy(retry);
    validatePredicateErrorPolicy(params.predicateError);
    validateOperationTimeout(timeout);
    const session = this.#lifecycle.acceptOperation();

    let scope!: SingleOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>;
    let requestSession!: QuerySession<TInput, TOutput>;

    scope = new SingleOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>({
      events: this.#events,
      dispatcher: this.#messages,
      session,
      operationType: "request",
      mode,
      receive: (message) => {
        if (!requestSession.observing) {
          return;
        }

        this.#processMessage({
          scope,
          message,
          predicate: requestSession.currentSelector,
          predicateType: "selector",
          policy: predicateError,
          onSelected: scope.resolve,
          onPredicateFailure: scope.reject,
        });
      },
      signal,
      timeout,
    });
    const { events } = scope;

    requestSession = new QuerySession<TInput, TOutput>({
      query,
      selector,
      evaluate: Unipls.#evaluateQuery,
      sendPayload: (payload) =>
        this.#socket.enqueue(payload, {
          force: mode.type === "transport",
          signal: scope.signal,
        }),
      onError: (error) => scope.reject(this.#translateSocketError(error)),
    });

    const request = (
      nextQuery: UniplsMessageFactory<TInput>,
      { selector: nextSelector }: { selector: (data: TOutput) => boolean },
    ) => {
      return requestSession.send(nextQuery, {
        selector: nextSelector,
        isDone: () => scope.resulted,
        canSend: () => this.#canSend(scope.session, mode),
      });
    };

    const sendInitial = () => {
      if (!requestSession.attempted) {
        void request(query, { selector });
      }
    };

    if (mode.type === "ready") {
      events.on("open", ({ session: openedSession }) => {
        if (openedSession === session) {
          sendInitial();
        }
      });
    }
    if (mode.type === "transport" || this.#isSessionReady(session)) {
      sendInitial();
    }

    const onReconnected = createOnReconnectedHandler({
      events,
      isDone: () => scope.resulted,
      request,
      onError: scope.reject,
    });

    const onDropped = createRetryingDropHandler({
      reconnectable: this.#reconnector !== undefined,
      retry,
      isDone: () => scope.resulted,
      onFatal: scope.reject,
      onReconnected,
      pauseForReconnect: () => requestSession.pauseForReconnect(),
      resumeWithoutResend: () => requestSession.resumeWithoutResend(),
      getQuery: () => requestSession.currentQuery,
      getSelector: () => requestSession.currentSelector,
    });

    events.on("dropped", (event) => {
      if (event.session === scope.session && requestSession.attempted) {
        onDropped(event);
      }
    });

    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) {
        return;
      }

      scope.reject(error ?? new UniplsClosedError());
    });

    return scope.promise;
  }

  #cast(params: UniplsCastParams<TInput>, mode: MessageDeliveryMode): Promise<void> {
    validateOperationParams(params, "cast");
    validateRequiredProperty(params, "query", "cast");
    const query = params.query;
    const signal = params.signal;
    const timeout = params.timeout;

    validateOperationSignal(signal);
    validateOperationTimeout(timeout);
    const session = this.#lifecycle.acceptOperation();

    const scope = new SingleOperationScope<void, TOutput, UniplsEvents<TOutput>>({
      events: this.#events,
      dispatcher: this.#messages,
      session,
      operationType: "cast",
      signal,
      timeout,
    });
    const { events } = scope;
    let attempted = false;

    const sendOnce = () => {
      if (scope.resulted || attempted) {
        return;
      }

      try {
        const payload = Unipls.#evaluateQuery(query);

        if (scope.resulted) {
          return;
        }
        if (!this.#canSend(session, mode)) {
          return;
        }

        attempted = true;
        this.#socket
          .enqueue(payload, { force: mode.type === "transport", signal: scope.signal })
          .then(() => scope.resolve())
          .catch((error) => {
            scope.reject(this.#translateSocketError(error));
          });
      } catch (error) {
        scope.reject(error);
      }
    };

    if (mode.type === "ready") {
      events.on("open", ({ session: openedSession }) => {
        if (openedSession === session) {
          sendOnce();
        }
      });
    }
    if (mode.type === "transport" || this.#isSessionReady(session)) {
      sendOnce();
    }

    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) {
        return;
      }

      scope.reject(error ?? new UniplsClosedError());
    });

    return scope.promise;
  }

  async #runProvisioner(transportEpochId: number, signal: AbortSignal): Promise<void> {
    const provisioningController = new AbortController();
    const operationSignal = AbortSignal.any([signal, provisioningController.signal]);
    const sessionId = this.#lifecycle.session;
    const connection = this.#currentTransportContext(transportEpochId)?.connection;

    if (!connection) {
      throw new UniplsSocketDroppedError();
    }

    const mode = { type: "transport" as const, connection };
    const resourceScope = Object.freeze({
      type: "connection" as const,
      session: sessionId,
      connection,
    });
    const connectionScope = this.#createResourceScope(resourceScope, signal);

    this.#connectionScopes.set(transportEpochId, connectionScope);
    const transaction = this.#createResourceScope(resourceScope);
    const setupTransaction = this.#createResourceScope(resourceScope);
    let setupCommitted = false;
    const assertCapability = () => {
      this.#assertCurrentTransport(transportEpochId, signal);

      if (provisioningController.signal.aborted) {
        throw new UniplsInvalidUsageError("provisioning capability の有効期間が終了しました。");
      }
    };
    const connectionContext: ConnectionSetupContext<TInput, TOutput> = Object.freeze({
      cast: (data: TInput) => {
        assertCapability();

        return this.#cast({ query: data, signal: operationSignal }, mode);
      },
      request: (params: Omit<UniplsRequestParams<TInput, TOutput>, "signal" | "retry">) => {
        assertCapability();

        return this.#request({ ...params, signal: operationSignal }, mode);
      },
      listen: ((
        params: UniplsListenCallbackParams<TOutput> | UniplsListenIteratorParams<TOutput>,
      ) => {
        assertCapability();

        return this.#listen({ ...params, signal: operationSignal }, mode);
      }) as ConnectionSetupContext<TInput, TOutput>["listen"],
      subscribe: ((
        params:
          | UniplsSubscribeCallbackParams<TInput, TOutput>
          | UniplsSubscribeIteratorParams<TInput, TOutput>,
      ) => {
        assertCapability();

        return this.#subscribe({ ...params, signal: operationSignal }, mode);
      }) as ConnectionSetupContext<TInput, TOutput>["subscribe"],
      session: sessionId,
      connection,
      signal: setupTransaction.signal,
      defer: setupTransaction.defer,
    });

    try {
      if (this.#lifecycle.isSessionBeginning) {
        if (this.#provisioner?.setupSession) {
          const sessionScope = this.#sessionScope;

          if (!sessionScope) {
            throw new UniplsSocketDroppedError();
          }

          const sessionTransaction = this.#createResourceScope(
            Object.freeze({ type: "session", session: sessionId }),
          );
          const sessionContext: SessionSetupContext = Object.freeze({
            session: sessionId,
            signal: sessionTransaction.signal,
            defer: sessionTransaction.defer,
          });

          try {
            await this.#runSetupHook(
              () => this.#provisioner?.setupSession?.(sessionContext),
              sessionTransaction,
              signal,
            );
            this.#assertCurrentTransport(transportEpochId, signal);
            sessionTransaction.commitTo(sessionScope, "session-setup");
          } catch (cause) {
            await sessionTransaction.dispose(cause);
            throw cause;
          }
          this.#assertCurrentTransport(transportEpochId, signal);
          this.#lifecycle.markSessionSetupCompleted();
        } else {
          this.#lifecycle.markSessionSetupCompleted();
        }
      }

      if (this.#provisioner) {
        await this.#runSetupHook(
          () => this.#provisioner?.setupConnection(connectionContext),
          setupTransaction,
          signal,
        );
        setupTransaction.commitTo(transaction, "connection-provisioner");
        setupCommitted = true;
      } else {
        await setupTransaction.dispose();
      }

      await this.#detectorManager.setup({
        transaction,
        createScope: () => this.#createResourceScope(resourceScope, signal),
        createContext: (identity, scope, fail) =>
          this.#createDropDetectorContext(transportEpochId, signal, identity, scope, fail),
        onRuntimeFailure: (identity, boundary, cause) => {
          this.#logDropDetectorFailure(resourceScope, identity, boundary, cause);
        },
      });
      this.#assertCurrentTransport(transportEpochId, signal);
      transaction.commitTo(connectionScope, "connection-setup");
      provisioningController.abort(
        new UniplsInvalidUsageError("provisioning receive operation の有効期間が終了しました。"),
      );
    } catch (err) {
      provisioningController.abort(err);

      if (!setupCommitted) {
        await setupTransaction.dispose(err);
      }

      await transaction.dispose(err);
      await connectionScope.dispose(err);
      this.#connectionScopes.delete(transportEpochId);
      throw err;
    }
  }

  #createDropDetectorContext(
    transportEpochId: number,
    signal: AbortSignal,
    identity: DropDetectorIdentity,
    scope: OwnedResourceScope,
    fail: (boundary: "guard" | "run", cause: unknown) => void,
  ): DropDetectorContext<TInput, TOutput> {
    const connection = this.#currentTransportContext(transportEpochId)?.connection;

    if (!connection) {
      throw new UniplsSocketDroppedError();
    }

    const mode = { type: "transport" as const, connection };
    const guard = <TArgs extends readonly unknown[]>(
      callback: (...args: TArgs) => void | PromiseLike<void>,
      boundary: "guard" | "run" = "guard",
    ) => {
      return (...args: TArgs): void => {
        if (scope.signal.aborted) {
          return;
        }

        let result: void | PromiseLike<void>;

        try {
          result = callback(...args);
        } catch (cause) {
          fail(boundary, cause);

          return;
        }

        if (this.#isPromiseLike(result)) {
          void Promise.resolve(result).catch((cause) => fail(boundary, cause));
        }
      };
    };

    return Object.freeze({
      detector: identity,
      sessionSignal: this.#lifecycle.signal,
      signal: scope.signal,
      defer: scope.defer,
      drop: (report?: DropDetectorReport) => {
        this.#socket.reportDrop(transportEpochId, {
          source: Object.freeze({ ...report, type: "detector", detector: identity }),
        });
      },
      request: (params: DropDetectorRequestParams<TInput, TOutput>) => {
        this.#assertCurrentTransport(transportEpochId, signal);

        return this.#request(
          {
            ...params,
            signal: AbortSignal.any([scope.signal, ...(params.signal ? [params.signal] : [])]),
          },
          mode,
        );
      },
      guard: <TArgs extends readonly unknown[]>(callback: (...args: TArgs) => MaybePromise<void>) =>
        guard(callback),
      run: (task: (taskSignal: AbortSignal) => MaybePromise<void>) =>
        guard(() => task(scope.signal), "run")(),
    });
  }

  #bindTransport(transportEpochId: number, connection: ConnectionId): void {
    this.#transportContexts.clear();
    this.#transportContexts.set(
      transportEpochId,
      Object.freeze({
        session: this.#lifecycle.session,
        connection,
      }),
    );
    const report = this.#socket.getDropReport(transportEpochId);

    if (report) {
      this.#handleTransportDrop(transportEpochId, report);
    }
  }

  #bridgeSocketEvents(): void {
    this.#socket.on("message", ({ transportEpochId, message }) => {
      const context = this.#currentTransportContext(transportEpochId);

      if (!context) {
        return;
      }

      this.#messages.dispatchTransport(context.session, context.connection, message);
      const snapshot = this.#lifecycle.snapshot;

      if (
        snapshot.phase !== "open" ||
        snapshot.session !== context.session ||
        snapshot.connection !== context.connection
      ) {
        return;
      }

      this.#messages.dispatchReady(context.session, message);
      this.#events.emit("message", Object.freeze({ ...context, message }));
    });
    this.#socket.on("failed", ({ transportEpochId, error }) => {
      const context = this.#currentTransportContext(transportEpochId);

      if (context) {
        this.#events.emit("failed", Object.freeze({ ...context, error }));
      }
    });
    this.#socket.on("closed", ({ transportEpochId }) => {
      const context = this.#transportContextForTerminalEvent(transportEpochId);

      if (context) {
        void this.#disposeConnectionScope(transportEpochId, new UniplsClosedError());
        this.#transportContexts.delete(transportEpochId);
      }
    });
    this.#socket.on("dropped", ({ transportEpochId, report }) => {
      this.#handleTransportDrop(transportEpochId, report);
    });
  }

  #startAttempt(connection: ConnectionId): void {
    let transportEpochId = Number.NaN;
    let transportSignal: AbortSignal | undefined;
    const socketOpening = this.#socket.open(async (signal) => {
      transportSignal = signal;
      this.#assertCurrentTransport(transportEpochId, signal);
      this.#lifecycle.markProvisioning(connection);
      await this.#runProvisioner(transportEpochId, signal);
      this.#assertCurrentTransport(transportEpochId, signal);
    });

    transportEpochId = this.#socket.transportEpochId;
    this.#bindTransport(transportEpochId, connection);

    void socketOpening.then(
      () => {
        if (!this.#lifecycle.isCurrentAttempt(connection)) {
          return;
        }

        this.#assertCurrentTransport(transportEpochId, transportSignal);
        const origin = this.#lifecycle.markReady(connection);
        const context = Object.freeze({ session: this.#lifecycle.session, connection });

        this.#events.emit("open", context);

        if (origin === "initial") {
          this.#resolvePendingOpen();
        } else {
          this.#events.emit("reconnect", this.#lifecycle.reconnectSucceeded());
        }

        this.#canonicalDrops.delete(transportEpochId);
      },
      async (error) => {
        if (!this.#lifecycle.isCurrentAttempt(connection)) {
          return;
        }

        const cause = this.#translateSocketError(error);

        await this.#disposeConnectionScope(transportEpochId, cause);

        if (!this.#lifecycle.isCurrentAttempt(connection)) {
          return;
        }

        const failureDrop = this.#canonicalDrops.get(transportEpochId);
        const context = this.#lifecycle.failAttempt(connection, cause, failureDrop);

        this.#canonicalDrops.delete(transportEpochId);

        if (!this.#reconnector) {
          if (context.origin === "initial") {
            this.#terminateInitial("attempt-failed", context);
          } else {
            this.#terminateRecovery("recovery-exhausted", cause);
          }

          return;
        }

        this.#runReconnectionPolicy(context);
      },
    );
  }

  #runReconnectionPolicy(context: ReconnectionContext): void {
    const reconnector = this.#reconnector;

    if (!reconnector || !this.#lifecycle.hasActiveSession) {
      return;
    }

    const run: ReconnectionPolicyRun = {
      context,
      settled: false,
      cleanupCalled: false,
    };

    this.#reconnectionPolicy = run;
    const select = (outcome: ReconnectionEngineOutcome, action: () => void) => {
      if (run.settled || this.#reconnectionPolicy !== run || !this.#lifecycle.hasActiveSession) {
        return;
      }

      run.settled = true;
      run.outcome = outcome;
      this.#reconnectionPolicy = undefined;
      this.#cleanupPolicy(run);
      action();
    };

    let setupResult: ReturnType<UniplsReconnector["setup"]>;

    try {
      setupResult = reconnector.setup(
        {
          reconnect: () =>
            select("retrying", () => {
              const connection = this.#lifecycle.beginNextAttempt();

              this.#startAttempt(connection);
            }),
          cancel: () =>
            select("cancelled", () => {
              this.#terminateFromPolicy(context, "cancelled");
            }),
          exhaust: (cause) =>
            select("exhausted", () => {
              this.#terminateFromPolicy(context, "exhausted", cause);
            }),
        },
        context,
      );
    } catch (cause) {
      this.#failReconnector(run, "setup", cause);

      return;
    }

    if (this.#isPromiseLike(setupResult)) {
      void Promise.resolve(setupResult).then(
        (cleanup) => this.#registerPolicyCleanup(run, cleanup),
        (cause) => this.#failReconnector(run, "policy", cause),
      );
    } else {
      this.#registerPolicyCleanup(run, setupResult);
    }
  }

  #registerPolicyCleanup(run: ReconnectionPolicyRun, cleanup: void | (() => void)): void {
    run.cleanup = cleanup ?? undefined;

    if (run.settled) {
      this.#cleanupPolicy(run);
    }
  }

  #cleanupPolicy(run: ReconnectionPolicyRun): void {
    if (run.cleanupCalled || !run.cleanup) {
      return;
    }

    run.cleanupCalled = true;
    try {
      run.cleanup();
    } catch {
      // cleanup failure の型付き診断は Task 12 の resource scope で扱います。
    }
  }

  #settlePolicy(outcome: ReconnectionEngineOutcome): void {
    const run = this.#reconnectionPolicy;

    if (!run || run.settled) {
      return;
    }

    run.settled = true;
    run.outcome = outcome;
    this.#reconnectionPolicy = undefined;
    this.#cleanupPolicy(run);
  }

  #failReconnector(
    run: ReconnectionPolicyRun,
    failurePoint: "setup" | "policy",
    cause: unknown,
  ): void {
    if (run.settled || this.#reconnectionPolicy !== run || !this.#lifecycle.hasActiveSession) {
      return;
    }

    run.settled = true;
    run.outcome = "reconnector-failed";
    this.#reconnectionPolicy = undefined;
    this.#cleanupPolicy(run);

    const { context } = run;

    if (context.origin === "initial") {
      const error = this.#terminateInitial("reconnector-failed", context, cause);

      this.#logReconnectorFailure(context, failurePoint, cause, error);
    } else {
      const error = this.#terminateRecovery("reconnector-failed", cause);

      if (error) {
        this.#logReconnectorFailure(context, failurePoint, cause, error);
      }
    }
  }

  #terminateFromPolicy(
    context: ReconnectionContext,
    outcome: "cancelled" | "exhausted",
    cause?: unknown,
  ): void {
    const terminalCause = cause ?? context.cause;

    if (context.origin === "initial") {
      this.#terminateInitial(
        outcome === "cancelled" ? "attempts-cancelled" : "attempts-exhausted",
        context,
        terminalCause,
      );
    } else {
      this.#terminateRecovery(
        outcome === "cancelled" ? "recovery-cancelled" : "recovery-exhausted",
        terminalCause,
      );
    }
  }

  #currentTransportContext(transportEpochId: number): ConnectionEventContext | undefined {
    if (!this.#socket.isCurrentTransportEpoch(transportEpochId)) {
      return undefined;
    }

    return this.#transportContexts.get(transportEpochId);
  }

  #disposeConnectionScope(transportEpochId: number, reason?: unknown): Promise<void> {
    const scope = this.#connectionScopes.get(transportEpochId);

    if (!scope) {
      return Promise.resolve();
    }

    const disposal = scope.dispose(reason);
    const forget = () => {
      if (this.#connectionScopes.get(transportEpochId) === scope) {
        this.#connectionScopes.delete(transportEpochId);
      }
    };

    if (scope.disposed) {
      forget();
    } else {
      void disposal.then(forget);
    }

    return disposal;
  }

  #activeSessionContext(): ConnectionEventContext | undefined {
    const snapshot = this.#lifecycle.snapshot;

    if (snapshot.phase === "open" || snapshot.phase === "provisioning") {
      return Object.freeze({ session: snapshot.session, connection: snapshot.connection });
    }
    if (snapshot.phase === "connecting" && snapshot.status === "attempting") {
      return Object.freeze({ session: snapshot.session, connection: snapshot.connection });
    }
    if (snapshot.phase === "recovering") {
      return Object.freeze({ session: snapshot.session, connection: snapshot.drop.connection });
    }

    return undefined;
  }

  #transportContextForTerminalEvent(transportEpochId: number): ConnectionEventContext | undefined {
    if (this.#socket.transportEpochId !== transportEpochId) {
      return undefined;
    }

    return this.#transportContexts.get(transportEpochId);
  }

  #handleTransportDrop(transportEpochId: number, report: UniplsSocketDropReport): void {
    const context = this.#transportContextForTerminalEvent(transportEpochId);

    if (!context || !this.#lifecycle.hasActiveSession) {
      return;
    }

    let drop = this.#canonicalDrops.get(transportEpochId);

    if (!drop) {
      drop = this.#lifecycle.createDrop(context.connection, report);
      this.#canonicalDrops.set(transportEpochId, drop);
    }

    const snapshot = this.#lifecycle.snapshot;
    const isAttempting =
      snapshot.phase === "provisioning" ||
      (snapshot.phase === "connecting" && snapshot.status === "attempting");

    if (isAttempting) {
      void this.#disposeConnectionScope(transportEpochId, report.cause ?? drop);
      this.#transportContexts.delete(transportEpochId);

      return;
    }

    this.#lifecycle.beginRecovery(drop);
    this.#transportContexts.delete(transportEpochId);
    const disposal = this.#disposeConnectionScope(transportEpochId, report.cause ?? drop);
    const continueAfterCleanup = () => {
      if (!this.#lifecycle.hasActiveSession) {
        return;
      }

      const terminalWithoutReconnector = this.#reconnector === undefined;
      const error = new UniplsDroppedError({
        outcome: terminalWithoutReconnector ? "recovery-exhausted" : "operation-failed",
        drop,
        attempts: this.#lifecycle.attempts,
        cause: report.cause,
      });

      this.#events.emit("dropped", Object.freeze({ ...context, drop, error }));

      if (terminalWithoutReconnector) {
        this.#terminateRecovery("recovery-exhausted", report.cause, error);

        return;
      }

      this.#runReconnectionPolicy(this.#lifecycle.buildRecoveryContext(report.cause ?? drop));
    };
    const scope = this.#connectionScopes.get(transportEpochId);

    if (!scope || scope.disposed) {
      continueAfterCleanup();
    } else {
      void disposal.then(continueAfterCleanup);
    }
  }

  #terminateInitial(
    outcome: "attempt-failed" | "attempts-cancelled" | "attempts-exhausted" | "reconnector-failed",
    context: ReconnectionContext,
    cause: unknown = context.cause,
  ): UniplsOpenError {
    const error = new UniplsOpenError({
      outcome,
      ...(outcome === "reconnector-failed" ? {} : { stage: context.stage }),
      attempts: context.attempts,
      cause,
      drop: context.drop,
    });
    const lastAttempt = context.attempts.at(-1);
    const connection = lastAttempt?.connection ?? context.drop?.connection;

    this.#settlePolicy(
      outcome === "attempts-cancelled"
        ? "cancelled"
        : outcome === "attempts-exhausted"
          ? "exhausted"
          : outcome === "reconnector-failed"
            ? "reconnector-failed"
            : "exhausted",
    );
    this.#socket.terminate(this.#socket.transportEpochId);
    this.#lifecycle.terminateInitial(outcome, error, cause, context.drop);
    this.#transportContexts.clear();
    this.#canonicalDrops.clear();
    this.#disposeSessionResources(error, () => {
      if (connection) {
        this.#events.emit("closed", Object.freeze({ session: context.session, connection, error }));
      }

      this.#rejectPendingOpen(error);
    });

    return error;
  }

  #terminateRecovery(
    outcome: Exclude<UniplsDroppedErrorOutcome, "operation-failed">,
    cause?: unknown,
    existingError?: UniplsDroppedError,
  ): UniplsDroppedError | undefined {
    if (!this.#lifecycle.hasActiveSession) {
      return undefined;
    }

    const drop = this.#lifecycle.recoveryDrop;
    const error =
      existingError ??
      new UniplsDroppedError({ outcome, drop, attempts: this.#lifecycle.attempts, cause });

    this.#settlePolicy(
      outcome === "recovery-cancelled"
        ? "cancelled"
        : outcome === "recovery-exhausted"
          ? "exhausted"
          : "reconnector-failed",
    );
    this.#socket.terminate(this.#socket.transportEpochId);
    this.#lifecycle.terminateRecovery(outcome, error, cause);
    this.#canonicalDrops.clear();
    this.#disposeSessionResources(error, () => {
      this.#events.emit(
        "closed",
        Object.freeze({
          session: drop.session,
          connection: drop.connection,
          error,
        }),
      );
    });

    return error;
  }

  #disposeSessionResources(reason: unknown, onComplete: () => void): void {
    const scopes = [...this.#connectionScopes.values()];

    this.#connectionScopes.clear();

    if (this.#sessionScope) {
      scopes.push(this.#sessionScope);
    }

    this.#sessionScope = undefined;
    let index = 0;
    const advance = () => {
      while (index < scopes.length) {
        const scope = scopes[index++] as OwnedResourceScope;
        const disposal = scope.dispose(reason);

        if (!scope.disposed) {
          void disposal.then(advance);

          return;
        }
      }
      onComplete();
    };

    advance();
  }

  #resolvePendingOpen(): void {
    const pending = this.#pendingOpen;

    if (!pending || pending.settled) {
      return;
    }

    pending.settled = true;
    this.#pendingOpen = undefined;
    pending.resolve();
  }

  #rejectPendingOpen(cause: unknown): void {
    const pending = this.#pendingOpen;

    if (!pending || pending.settled) {
      return;
    }

    pending.settled = true;
    this.#pendingOpen = undefined;
    pending.reject(cause);
  }

  #emitLog(log: UniplsLog): void {
    try {
      this.#logSink?.(log);
    } catch {
      // log sink の失敗は library の処理へ逆流させません。
    }
  }

  #forwardSocketLog(log: UniplsLog): void {
    const transportEpochId = log.context?.transportEpochId;
    const transport =
      typeof transportEpochId === "number"
        ? this.#currentTransportContext(transportEpochId)
        : undefined;

    this.#emitLog(
      Object.freeze({
        ...log,
        context: Object.freeze({
          ...log.context,
          ...(transport ? { session: transport.session, connection: transport.connection } : {}),
        }),
      }),
    );
  }

  #logReconnectorFailure(
    context: ReconnectionContext,
    failurePoint: "setup" | "policy",
    cause: unknown,
    error: UniplsOpenError | UniplsDroppedError,
  ): void {
    this.#emitLog(
      Object.freeze({
        level: "error",
        event: "resilience/reconnection",
        message: "接続回復処理に失敗しました。",
        context: Object.freeze({
          session: context.session,
          origin: context.origin,
          failurePoint,
          error,
        }),
        cause,
      }),
    );
  }

  #createResourceScope(scope: UniplsResourceScope, parentSignal?: AbortSignal): OwnedResourceScope {
    return new OwnedResourceScope({
      scope,
      parentSignal,
      onCleanupFailure: ({ cause, scope: owner, name, source: registeredBy }) => {
        if (!this.#logSink) {
          return;
        }

        this.#emitLog(
          Object.freeze({
            level: "error",
            event: "resource/cleanup",
            message: "resource の解放処理に失敗しました。",
            context: Object.freeze({
              ...owner,
              ...(name === undefined ? {} : { resourceName: name }),
              resourceSource: registeredBy,
            }),
            cause,
          }),
        );
      },
    });
  }

  async #runSetupHook(
    setup: () => void | Disposer | PromiseLike<void | Disposer> | undefined,
    transaction: OwnedResourceScope,
    signal: AbortSignal,
  ): Promise<void> {
    const returned = await this.#waitForProvisioning(setup(), signal);

    if (returned === undefined) {
      return;
    }
    if (typeof returned !== "function") {
      throw new TypeError("setup hook は disposer 関数または void を返してください。");
    }

    transaction.deferReturned(returned);
  }

  #logDropDetectorFailure(
    scope: Extract<UniplsResourceScope, { type: "connection" }>,
    detector: DropDetectorIdentity,
    boundary: "guard" | "run",
    cause: unknown,
  ): void {
    if (!this.#logSink) {
      return;
    }

    this.#emitLog(
      Object.freeze({
        level: "warning",
        event: "resilience/drop-detection",
        message: "接続 drop の検出処理に失敗しました。",
        context: Object.freeze({ ...scope, detector, boundary }),
        cause,
      }),
    );
  }

  #isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
      (typeof value === "object" && value !== null && "then" in value) ||
      (typeof value === "function" && "then" in value)
    );
  }

  #assertCurrentTransport(transportEpochId: number, signal?: AbortSignal): void {
    if (
      signal?.aborted ||
      !this.#transportContexts.has(transportEpochId) ||
      !this.#socket.isCurrentTransportEpoch(transportEpochId)
    ) {
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
        if (settled) {
          return;
        }

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
   * メッセージを1件送信し、selector に一致する受信メッセージを購読します。初期化中の場合は ready になるまで送信を待ちます。
   *
   * callback の `onMatch` を指定すると subscription handle、指定しない場合は single-consumer の AsyncSubscription を返します。
   * callback の戻り値や Promise は待機しないため、callback delivery は逐次実行を保証しません。
   *
   * @throws {TypeError} 必須値、deliveryまたはpolicyの型が不正な場合に同期的に投げます。
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  subscribe(
    params: UniplsSubscribeCallbackParams<TInput, TOutput>,
  ): SubscriptionHandle<StreamFinalization<TOutput>>;
  subscribe(params: UniplsSubscribeIteratorParams<TInput, TOutput>): AsyncSubscription<TOutput>;
  subscribe(
    params:
      | UniplsSubscribeCallbackParams<TInput, TOutput>
      | UniplsSubscribeIteratorParams<TInput, TOutput>,
  ): SubscriptionHandle<StreamFinalization<TOutput>> | AsyncSubscription<TOutput> {
    return this.#subscribe(params, { type: "ready" });
  }

  #subscribe(
    params:
      | UniplsSubscribeCallbackParams<TInput, TOutput>
      | UniplsSubscribeIteratorParams<TInput, TOutput>,
    mode: MessageDeliveryMode,
  ): SubscriptionHandle<StreamFinalization<TOutput>> | AsyncSubscription<TOutput> {
    validateOperationParams(params, "subscribe");
    validateRequiredProperty(params, "query", "subscribe");
    const query = params.query;
    const selector = params.selector;
    const terminator = params.terminator ?? (() => false);
    const signal = params.signal;
    const timeout = params.timeout;
    const retry = params.retry;
    const predicateError = params.predicateError ?? "continue";
    const callback = params.onMatch;

    validateRequiredCallback(selector, "selector", "subscribe");
    validateOptionalCallback(params.terminator, "terminator", "subscribe");
    validateOperationSignal(signal);
    validateRetryStrategy(retry);
    validatePredicateErrorPolicy(params.predicateError);
    validateStreamDelivery(params, "subscribe");
    const callbackError = params.callbackError ?? "continue";
    const buffer = callback === undefined ? normalizeStreamBuffer(params.buffer) : undefined;

    validateOperationTimeout(timeout);
    const session = this.#lifecycle.acceptOperation();

    let scope!: StreamOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>;
    let requestSession!: QuerySession<TInput, TOutput>;

    scope = new StreamOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>({
      events: this.#events,
      dispatcher: this.#messages,
      session,
      operationType: "subscribe",
      mode,
      receive: (message) => {
        if (!requestSession.observing) {
          return;
        }

        const terminatorResult = this.#processMessage({
          scope,
          message,
          predicate: terminator,
          predicateType: "terminator",
          policy: predicateError,
          onSelected: scope.handleTerminator,
          onPredicateFailure: scope.raiseFatalError,
        });

        if (terminatorResult !== "unmatched") {
          return;
        }

        this.#processMessage({
          scope,
          message,
          predicate: requestSession.currentSelector,
          predicateType: "selector",
          policy: predicateError,
          onSelected: scope.handleMessage,
          onPredicateFailure: scope.raiseFatalError,
        });
      },
      delivery:
        callback === undefined
          ? {
              type: "iterator",
              buffer: buffer as ReturnType<typeof normalizeStreamBuffer>,
              onMessageDropped: (strategy, capacity) => {
                this.#logStreamMessageDropped(scope, strategy, capacity);
              },
            }
          : {
              type: "callback",
              onMatch: callback,
              policy: callbackError as StreamCallbackErrorPolicy,
              onCallbackError: (cause, policy) => {
                if (policy === "unsubscribe") {
                  scope.failCallback(cause);
                }

                this.#logStreamCallbackFailure(scope, cause, policy);
              },
            },
      signal,
      timeout,
    });
    const { events } = scope;

    requestSession = new QuerySession<TInput, TOutput>({
      query,
      selector,
      evaluate: Unipls.#evaluateQuery,
      sendPayload: (payload) =>
        this.#socket.enqueue(payload, {
          force: mode.type === "transport",
          signal: scope.signal,
        }),
      onError: (error) => scope.raiseFatalError(this.#translateSocketError(error)),
    });

    const request = (
      nextQuery: UniplsMessageFactory<TInput>,
      { selector: nextSelector }: { selector: (data: TOutput) => boolean },
    ) => {
      return requestSession.send(nextQuery, {
        selector: nextSelector,
        isDone: () => scope.resulted,
        canSend: () => this.#canSend(scope.session, mode),
      });
    };

    const sendInitial = () => {
      if (!requestSession.attempted) {
        void request(query, { selector });
      }
    };

    if (mode.type === "ready") {
      events.on("open", ({ session: openedSession }) => {
        if (openedSession === session) {
          sendInitial();
        }
      });
    }
    if (mode.type === "transport" || this.#isSessionReady(session)) {
      sendInitial();
    }

    const onReconnected = createOnReconnectedHandler({
      events,
      isDone: () => scope.resulted,
      request,
      onError: scope.raiseFatalError,
    });

    const onDropped = createRetryingDropHandler({
      reconnectable: this.#reconnector !== undefined,
      retry,
      isDone: () => scope.resulted,
      onFatal: scope.raiseFatalError,
      onReconnected,
      pauseForReconnect: () => requestSession.pauseForReconnect(),
      resumeWithoutResend: () => requestSession.resumeWithoutResend(),
      getQuery: () => requestSession.currentQuery,
      getSelector: () => requestSession.currentSelector,
    });

    events.on("dropped", (event) => {
      if (event.session === scope.session && requestSession.attempted) {
        onDropped(event);
      }
    });

    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) {
        return;
      }
      if (error) {
        scope.raiseFatalError(error);
      } else {
        scope.close();
      }
    });

    return scope.handle;
  }

  static #evaluateQuery<TInput>(query: UniplsMessageFactory<TInput>): TInput {
    if (typeof query === "function") {
      return (query as () => TInput)();
    }

    return query;
  }

  #translateSocketError(error: unknown): unknown {
    if (error instanceof UniplsSocketClosedError) {
      return new UniplsClosedError();
    }
    if (error instanceof UniplsSocketDroppedError) {
      const drop = this.#canonicalDrops.get(this.#socket.transportEpochId);

      if (drop && this.#lifecycle.hasActiveSession) {
        return new UniplsDroppedError({
          outcome: "operation-failed",
          drop,
          attempts: this.#lifecycle.attempts,
          cause: error,
        });
      }
    }

    return error;
  }

  #isSessionReady(session: SessionId): boolean {
    const snapshot = this.#lifecycle.snapshot;

    return snapshot.phase === "open" && snapshot.session === session;
  }

  #canSend(session: SessionId, mode: MessageDeliveryMode): boolean {
    if (mode.type === "ready") {
      return this.#isSessionReady(session);
    }

    const snapshot = this.#lifecycle.snapshot;

    if (snapshot.phase === "closed" || snapshot.session !== session) {
      return false;
    }

    return (
      (snapshot.phase === "open" ||
        snapshot.phase === "provisioning" ||
        (snapshot.phase === "connecting" && snapshot.status === "attempting")) &&
      snapshot.connection === mode.connection
    );
  }

  #logStreamCallbackFailure(
    scope: Readonly<{
      operation: import("../shared/types.ts").OperationId;
      operationType: import("../shared/types.ts").OperationType;
      session: SessionId;
    }>,
    cause: unknown,
    policy: StreamCallbackErrorPolicy,
  ): void {
    if (!this.#logSink) {
      return;
    }

    this.#emitLog(
      Object.freeze({
        level: policy === "continue" ? "warning" : "error",
        event: "operation/message-handler",
        message: "message handler の実行に失敗しました。",
        context: Object.freeze({ ...scope, policy }),
        cause,
      }),
    );
  }

  #logStreamMessageDropped(
    scope: Readonly<{
      operation: import("../shared/types.ts").OperationId;
      operationType: import("../shared/types.ts").OperationType;
      session: SessionId;
    }>,
    strategy: "latest" | "drop-oldest" | "drop-newest",
    capacity: number,
  ): void {
    if (!this.#logSink) {
      return;
    }

    this.#emitLog(
      Object.freeze({
        level: "warning",
        event: "message/overflow",
        message: "buffer policy により message が破棄されました。",
        context: Object.freeze({ ...scope, strategy, capacity }),
      }),
    );
  }

  #processMessage({
    scope,
    message,
    predicate,
    predicateType,
    policy,
    onSelected,
    onPredicateFailure,
  }: {
    scope: Readonly<{
      operation: import("../shared/types.ts").OperationId;
      operationType: import("../shared/types.ts").OperationType;
      session: SessionId;
    }>;
    message: TOutput;
    predicate: (message: TOutput) => boolean;
    predicateType: "selector" | "terminator";
    policy: PredicateErrorPolicy;
    onSelected: (message: TOutput) => void;
    onPredicateFailure: (cause: unknown) => void;
  }): "matched" | "unmatched" | "failed" {
    let selected: boolean;

    try {
      selected = predicate(message);
    } catch (cause) {
      if (policy === "fail") {
        onPredicateFailure(cause);
      }
      if (this.#logSink) {
        this.#emitLog(
          Object.freeze({
            level: policy === "continue" ? "warning" : "error",
            event: predicateType === "selector" ? "operation/selection" : "operation/termination",
            message:
              predicateType === "selector"
                ? "message selection の評価に失敗しました。"
                : "termination の評価に失敗しました。",
            context: Object.freeze({ ...scope, policy }),
            cause,
          }),
        );
      }

      return "failed";
    }

    if (!selected) {
      return "unmatched";
    }

    try {
      onSelected(message);
    } catch {
      // user callbackとpredicateは個別の境界で処理済みのため、内部settleの競合だけを隔離します。
    }

    return "matched";
  }
}
