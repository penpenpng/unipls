import { AsyncResult } from "./async-result.ts";
import type { UniplsSubscriber } from "./async-results.ts";
import type { DropDetectorContext } from "./drop-detector";
import { DropDetectorManager } from "./drop-detector/drop-detector-manager.ts";
import {
  UniplsClosedError,
  UniplsDroppedError,
  UniplsDuplicatedConnectionError,
  UniplsInvalidUsageError,
  UniplsOpenError,
  UniplsSocketClosedError,
  UniplsSocketDroppedError,
} from "./errors.ts";
import { EventBus } from "./event-bus";
import { UniplsLifecycleCoordinator } from "./lifecycle.ts";
import { createDropWaitHandler, createRetryingDropHandler } from "./operations/drop-policy.ts";
import {
  SingleOperationScope,
  StreamOperationScope,
  validateOperationTimeout,
} from "./operations/operation-scope.ts";
import { MessageDispatcher, type MessageDeliveryMode } from "./operations/message-dispatcher.ts";
import { QuerySession } from "./operations/query-session.ts";
import { createOnReconnectedHandler } from "./operations/reconnect-hook.ts";
import type {
  ReconnectionContext,
  UniplsReconnectEvent,
  UniplsReconnector,
} from "./reconnector/reconnector.ts";
import type {
  ConnectionId,
  DropDetectorIdentity,
  MessagePredicateFailedDiagnostic,
  ReconnectionEngineOutcome,
  SessionId,
  UniplsConnectionState,
  UniplsDiagnostic,
  UniplsDrop,
  UniplsDroppedErrorOutcome,
  UniplsLifecycleSnapshot,
  PredicateErrorPolicy,
  WebSocketData,
} from "./types.ts";
import { UniplsSocket, type UniplsSocketDropReport } from "./unipls-socket";
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

/** 公開 event を発生させた論理セッションと接続を識別します。 */
interface ConnectionEventContext {
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

type UniplsEvents<TOutput> = {
  /** 接続が ready になったときに通知されます。 */
  open: ConnectionEventContext;
  /** メッセージを受信して変換できたときに通知されます。 */
  message: ConnectionEventContext & { message: TOutput };
  /** 論理セッションが終了したときに通知されます。 */
  closed: ConnectionEventContext & { error?: UniplsOpenError | UniplsDroppedError };
  /** ready だった接続を失ったときに通知されます。 */
  dropped: ConnectionEventContext & { drop: UniplsDrop; error: UniplsDroppedError };
  /** 接続の初期化処理が失敗したときに通知されます。 */
  failed: ConnectionEventContext & { error: unknown };
  /** 論理セッションの lifecycle が遷移したときに通知されます。 */
  lifecycle: {
    previous: UniplsLifecycleSnapshot;
    current: UniplsLifecycleSnapshot;
  };
  /** 接続回復が成功したときに通知されます。 */
  reconnect: UniplsReconnectEvent;
  /** ライブラリが捕捉した型付きの診断情報です。 */
  diagnostic: UniplsDiagnostic;
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
  #pendingOpen?: PendingOpen;
  #reconnectionPolicy?: ReconnectionPolicyRun;
  #lifecycle: UniplsLifecycleCoordinator;
  #detectorManager: DropDetectorManager<TInput, TOutput>;
  /** 接続先の WebSocket URL です。 */
  get url(): string {
    return this.#socket.url;
  }
  /** 現在の WebSocket 接続状態です。 */
  get state(): UniplsConnectionState {
    return this.#socket.state;
  }
  /** 現在の接続意図です。 */
  get intent() {
    return this.#socket.intent;
  }
  /** 論理セッションの現在状態を表す不変なスナップショットです。 */
  get lifecycle(): UniplsLifecycleSnapshot {
    return this.#lifecycle.snapshot;
  }
  /** subclass が公開 event を購読・通知するための event bus です。 */
  protected get events(): EventBus<UniplsEvents<TOutput>> {
    return this.#events;
  }
  /** 公開イベントの listener を登録します。 */
  get on() {
    return this.events.on.bind(this.events);
  }
  /** 公開イベントの listener を解除します。 */
  get off() {
    return this.events.off.bind(this.events);
  }

  /** 接続先と通信方針を指定して client を作成します。 */
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
   * @param provisioner WebSocket 接続後、ready になる前に行う初期化処理です。
   * @returns WebSocket 接続と初期化が完了すると解決する Promise です。
   *
   * @throws {UniplsDuplicatedConnectionError} WebSocket が既に接続されているか、接続を試行中の場合に例外を投げます。
   */
  open(provisioner?: UniplsProvisioner<TInput, TOutput>): Promise<void> {
    if (this.#lifecycle.hasActiveSession) {
      throw new UniplsDuplicatedConnectionError();
    }

    this.#provisioner = provisioner;
    const connection = this.#lifecycle.beginSession();
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
    this.#detectorManager.stop();
    this.#canonicalDrops.clear();
    this.#rejectPendingOpen(closedError);
    if (context) {
      this.events.emit("closed", context);
    }
    return closing;
  }

  /** `await using` の終了時に論理セッションを閉じます。 */
  async [Symbol.asyncDispose]() {
    await this.close();
  }

  /** 現在の接続を手動で drop として報告します。 */
  drop(): void {
    return this.#socket.drop();
  }

  /**
   * selector に最初に一致する受信メッセージを待ちます。
   *
   * @returns 一致するメッセージで解決し、受付後に session が終了した場合や timeout、中断時にはその理由で reject する Promise です。
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  next(params: UniplsNextParams<TOutput>): Promise<TOutput> {
    const selector = params.selector;
    const signal = params.signal;
    const timeout = params.timeout;
    const retry = params.retry;
    const predicateError = params.predicateError ?? "continue";
    validateOperationTimeout(timeout);
    if (signal?.aborted) throw signal.reason;
    const session = this.#lifecycle.acceptOperation();

    let scope!: SingleOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>;
    scope = new SingleOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>({
      events: this.events,
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
      if (event.session !== scope.session) return;
      createDropWaitHandler({
        reconnectable: this.#reconnector !== undefined,
        retry,
        isDone: () => scope.resulted,
        onFatal: scope.reject,
      })(event);
    });

    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) return;
      scope.reject(error ?? new UniplsClosedError());
    });

    return scope.promise;
  }

  /**
   * selector に一致する受信メッセージを購読します。
   *
   * @returns 購読を解除する関数を返します。
   *
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  listen(params: UniplsSubscriber<TOutput> & UniplsListenOptions<TOutput>): () => void {
    return this.#listen(params, { type: "ready" });
  }

  #listen(
    params: UniplsSubscriber<TOutput> & UniplsListenOptions<TOutput>,
    mode: MessageDeliveryMode,
  ): () => void {
    const selector = params.selector ?? (() => true);
    const terminator = params.terminator ?? (() => false);
    const signal = params.signal;
    const timeout = params.timeout;
    const retry = params.retry;
    const predicateError = params.predicateError ?? "continue";
    validateOperationTimeout(timeout);
    if (signal?.aborted) throw signal.reason;
    const session = this.#lifecycle.acceptOperation();

    let scope!: StreamOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>;
    scope = new StreamOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>({
      events: this.events,
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
        if (terminatorResult !== "unmatched") return;
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
      subscriber: params,
      signal,
      timeout,
    });
    const { events } = scope;

    events.on("dropped", (event) => {
      if (event.session !== scope.session) return;
      createDropWaitHandler({
        reconnectable: this.#reconnector !== undefined,
        retry,
        isDone: () => scope.resulted,
        onFatal: scope.raiseFatalError,
      })(event);
    });
    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) return;
      scope.raiseFatalError(error ?? new UniplsClosedError());
    });

    return scope.unsubscribe;
  }

  /**
   * 1件のメッセージを送信します。初期化中の場合は ready になるまで送信を待ちます。
   *
   * @returns メッセージの送信が完了すると解決する Promise です。
   *
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  cast(params: UniplsCastParams<TInput>): Promise<void> {
    return this.#cast(params, false);
  }

  /**
   * {@link Unipls.cast} と同じですが、WebSocket が開いた時点で初期化の完了を待たずに送信します。
   */
  castForce(params: UniplsCastParams<TInput>): Promise<void> {
    return this.#cast(params, true);
  }

  /**
   * 1件のメッセージを送信し、selector に最初に一致する応答を待ちます。初期化中の場合は ready になるまで送信を待ちます。
   *
   * @returns selector に一致するメッセージで解決する Promise です。
   *
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  request(params: UniplsRequestParams<TInput, TOutput>): Promise<TOutput> {
    return this.#request(params, { type: "ready" });
  }

  /**
   * {@link Unipls.request} と同じですが、WebSocket が開いた時点で初期化の完了を待たずに送信します。
   */
  requestForce(params: UniplsRequestParams<TInput, TOutput>): Promise<TOutput> {
    return this.#request(params, this.#activeTransportMode());
  }

  #request(
    params: UniplsRequestParams<TInput, TOutput>,
    mode: MessageDeliveryMode,
  ): Promise<TOutput> {
    const query = params.query;
    const selector = params.selector;
    const signal = params.signal;
    const timeout = params.timeout;
    const retry = params.retry;
    const predicateError = params.predicateError ?? "continue";
    validateOperationTimeout(timeout);
    if (signal?.aborted) throw signal.reason;
    const session = this.#lifecycle.acceptOperation();

    let scope!: SingleOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>;
    let requestSession!: QuerySession<TInput, TOutput>;
    scope = new SingleOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>({
      events: this.events,
      dispatcher: this.#messages,
      session,
      operationType: "request",
      mode,
      receive: (message) => {
        if (!requestSession.sent) return;
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
      query: UniplsMessageFactory<TInput>,
      { selector }: { selector: (data: TOutput) => boolean },
    ) => {
      requestSession.send(query, {
        selector,
        isDone: () => scope.resulted,
      });
    };

    const sendInitial = () => {
      if (!requestSession.sent) request(query, { selector });
    };
    if (mode.type === "transport" || this.#isSessionReady(session)) sendInitial();
    else {
      events.on("open", ({ session: openedSession }) => {
        if (openedSession === session) sendInitial();
      });
    }

    const onReconnected = createOnReconnectedHandler({
      events,
      isDone: () => scope.resulted,
      reset: () => requestSession.resetForReconnect(),
      request,
      onError: scope.reject,
    });

    const onDropped = createRetryingDropHandler({
      reconnectable: this.#reconnector !== undefined,
      retry,
      isDone: () => scope.resulted,
      onFatal: scope.reject,
      onReconnected,
      getQuery: () => requestSession.currentQuery,
      getSelector: () => requestSession.currentSelector,
    });
    events.on("dropped", (event) => {
      if (event.session === scope.session) onDropped(event);
    });

    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) return;
      scope.reject(error ?? new UniplsClosedError());
    });

    return scope.promise;
  }

  #cast(params: UniplsCastParams<TInput>, force: boolean): Promise<void> {
    const query = params.query;
    const signal = params.signal;
    const timeout = params.timeout;
    validateOperationTimeout(timeout);
    if (signal?.aborted) throw signal.reason;
    const session = this.#lifecycle.acceptOperation();

    const scope = new SingleOperationScope<void, TOutput, UniplsEvents<TOutput>>({
      events: this.events,
      dispatcher: this.#messages,
      session,
      operationType: "cast",
      signal,
      timeout,
    });
    const { events } = scope;

    const sendOnce = () => {
      if (scope.resulted) return;
      try {
        const payload = Unipls.#evaluateQuery(query);
        if (scope.resulted) return;
        this.#socket
          .enqueue(payload, { force, signal: scope.signal })
          .then(() => scope.resolve())
          .catch((error) => {
            scope.reject(this.#translateSocketError(error));
          });
      } catch (error) {
        scope.reject(error);
      }
    };

    if (force || this.#isSessionReady(session)) {
      sendOnce();
    } else {
      events.on("open", ({ session: openedSession }) => {
        if (openedSession === session) sendOnce();
      });
    }

    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) return;
      scope.reject(error ?? new UniplsClosedError());
    });

    return scope.promise;
  }

  async #runProvisioner(transportEpochId: number, signal: AbortSignal): Promise<void> {
    const result = new AsyncResult<void>();
    const provisioningController = new AbortController();
    const operationSignal = AbortSignal.any([signal, provisioningController.signal]);
    const sessionId = this.#lifecycle.session;
    const isSessionBeginning = this.#lifecycle.isSessionBeginning;
    const connection = this.#currentTransportContext(transportEpochId)?.connection;
    if (!connection) throw new UniplsSocketDroppedError();
    const mode = { type: "transport" as const, connection };

    const ctx: UniplsProvisioningContext<TInput, TOutput> = {
      cast: (data) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        return this.castForce({ query: data, signal: operationSignal });
      },
      request: (params) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        return this.#request({ ...params, signal: operationSignal }, mode);
      },
      listen: (params) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        this.#listen({ ...params, signal: operationSignal }, mode);
      },
      subscribe: (params) => {
        this.#assertCurrentTransport(transportEpochId, signal);
        return this.#subscribe({ ...params, signal: operationSignal }, mode);
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
      provisioningController.abort(
        new UniplsInvalidUsageError("provisioning receive operation の有効期間が終了しました。"),
      );
      result.resolve();
    } catch (err) {
      provisioningController.abort(err);
      result.reject(err);
    }

    return result.promise;
  }

  #createDropDetectorContext(
    transportEpochId: number,
    signal: AbortSignal,
    identity: DropDetectorIdentity,
  ): DropDetectorContext<TInput, TOutput> {
    return {
      drop: () => {
        this.#socket.reportDrop(transportEpochId, {
          source: Object.freeze({ type: "detector", detector: identity }),
        });
      },
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
    const report = this.#socket.getDropReport(transportEpochId);
    if (report) {
      this.#handleTransportDrop(transportEpochId, report);
    }
  }

  #bridgeSocketEvents(): void {
    this.#socket.events.on("message", ({ epoch, message }) => {
      const context = this.#currentTransportContext(epoch.id);
      if (!context) return;
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
      this.events.emit("message", { ...context, message });
    });
    this.#socket.events.on("error", ({ epoch, error, messageSequence, input }) => {
      const context = this.#currentTransportContext(epoch.id);
      if (!context) return;
      const scope = Object.freeze({
        type: "connection" as const,
        session: context.session,
        connection: context.connection,
        messageSequence,
      });
      const diagnostic: UniplsDiagnostic = Object.freeze({
        type: "message-deserialization-failed",
        severity: "warning",
        scope,
        occurredAt: Date.now(),
        cause: error,
        input,
      });
      this.events.emitIsolated("diagnostic", diagnostic);
    });
    this.#socket.events.on("failed", ({ epoch, error }) => {
      const context = this.#currentTransportContext(epoch.id);
      if (context) {
        this.events.emit("failed", { ...context, error });
      }
    });
    this.#socket.events.on("closed", ({ epoch }) => {
      const context = this.#transportContextForTerminalEvent(epoch.id);
      if (context) {
        this.#detectorManager.stop(epoch.id);
        this.events.emit("closed", context);
        this.#transportContexts.delete(epoch.id);
      }
    });
    this.#socket.events.on("dropped", ({ epoch, report }) => {
      this.#handleTransportDrop(epoch.id, report);
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
      this.#detectorManager.start(transportEpochId, (identity) =>
        this.#createDropDetectorContext(transportEpochId, signal, identity),
      );
    });
    transportEpochId = this.#socket.transportEpochId;
    this.#bindTransport(transportEpochId, connection);

    void socketOpening.then(
      () => {
        if (!this.#lifecycle.isCurrentAttempt(connection)) return;
        this.#assertCurrentTransport(transportEpochId, transportSignal);
        const origin = this.#lifecycle.markReady(connection);
        const context = { session: this.#lifecycle.session, connection };
        this.events.emit("open", context);
        if (origin === "initial") {
          this.#resolvePendingOpen();
        } else {
          this.events.emit("reconnect", this.#lifecycle.reconnectSucceeded());
        }
        this.#canonicalDrops.delete(transportEpochId);
      },
      (error) => {
        if (!this.#lifecycle.isCurrentAttempt(connection)) return;
        const cause = this.#translateSocketError(error);
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
    if (!reconnector || !this.#lifecycle.hasActiveSession) return;

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
    if (run.settled) this.#cleanupPolicy(run);
  }

  #cleanupPolicy(run: ReconnectionPolicyRun): void {
    if (run.cleanupCalled || !run.cleanup) return;
    run.cleanupCalled = true;
    try {
      run.cleanup();
    } catch {
      // cleanup failure の型付き診断は Task 12 の resource scope で扱います。
    }
  }

  #settlePolicy(outcome: ReconnectionEngineOutcome): void {
    const run = this.#reconnectionPolicy;
    if (!run || run.settled) return;
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
    if (run.settled || this.#reconnectionPolicy !== run || !this.#lifecycle.hasActiveSession)
      return;
    run.settled = true;
    run.outcome = "reconnector-failed";
    this.#reconnectionPolicy = undefined;
    this.#cleanupPolicy(run);

    const { context } = run;
    if (context.origin === "initial") {
      const error = this.#terminateInitial("reconnector-failed", context, cause);
      this.#emitReconnectorDiagnostic(context, failurePoint, cause, error);
    } else {
      const error = this.#terminateRecovery("reconnector-failed", cause);
      if (error) this.#emitReconnectorDiagnostic(context, failurePoint, cause, error);
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

  #activeSessionContext(): ConnectionEventContext | undefined {
    const snapshot = this.#lifecycle.snapshot;
    if (snapshot.phase === "open" || snapshot.phase === "provisioning") {
      return { session: snapshot.session, connection: snapshot.connection };
    }
    if (snapshot.phase === "connecting" && snapshot.status === "attempting") {
      return { session: snapshot.session, connection: snapshot.connection };
    }
    if (snapshot.phase === "recovering") {
      return { session: snapshot.session, connection: snapshot.drop.connection };
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
    this.#detectorManager.stop(transportEpochId);

    const snapshot = this.#lifecycle.snapshot;
    const isAttempting =
      snapshot.phase === "provisioning" ||
      (snapshot.phase === "connecting" && snapshot.status === "attempting");
    if (isAttempting) {
      this.#transportContexts.delete(transportEpochId);
      return;
    }

    this.#lifecycle.beginRecovery(drop);
    const terminalWithoutReconnector = this.#reconnector === undefined;
    const error = new UniplsDroppedError({
      outcome: terminalWithoutReconnector ? "recovery-exhausted" : "operation-failed",
      drop,
      attempts: this.#lifecycle.attempts,
      cause: report.cause,
    });
    this.events.emit("dropped", { ...context, drop, error });
    this.#transportContexts.delete(transportEpochId);

    if (terminalWithoutReconnector) {
      this.#terminateRecovery("recovery-exhausted", report.cause, error);
      return;
    }
    this.#runReconnectionPolicy(this.#lifecycle.buildRecoveryContext(report.cause ?? drop));
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
    this.#detectorManager.stop();
    this.#socket.terminate(this.#socket.transportEpochId);
    this.#lifecycle.terminateInitial(outcome, error, cause, context.drop);
    this.#transportContexts.clear();
    this.#canonicalDrops.clear();
    if (connection) {
      this.events.emit("closed", { session: context.session, connection, error });
    }
    this.#rejectPendingOpen(error);
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
    this.#detectorManager.stop();
    this.#socket.terminate(this.#socket.transportEpochId);
    this.#lifecycle.terminateRecovery(outcome, error, cause);
    this.#canonicalDrops.clear();
    this.events.emit("closed", {
      session: drop.session,
      connection: drop.connection,
      error,
    });
    return error;
  }

  #resolvePendingOpen(): void {
    const pending = this.#pendingOpen;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.#pendingOpen = undefined;
    pending.resolve();
  }

  #rejectPendingOpen(cause: unknown): void {
    const pending = this.#pendingOpen;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.#pendingOpen = undefined;
    pending.reject(cause);
  }

  #emitReconnectorDiagnostic(
    context: ReconnectionContext,
    failurePoint: "setup" | "policy",
    cause: unknown,
    error: UniplsOpenError | UniplsDroppedError,
  ): void {
    const scope = Object.freeze({ type: "session" as const, session: context.session });
    const common = {
      type: "reconnector-failed" as const,
      severity: "error" as const,
      scope,
      occurredAt: Date.now(),
      failurePoint,
      cause,
    };
    const diagnostic: UniplsDiagnostic =
      context.origin === "initial"
        ? Object.freeze({
            ...common,
            context: "initial-open" as const,
            error: error as UniplsOpenError,
          })
        : Object.freeze({
            ...common,
            context: "recovery" as const,
            error: error as UniplsDroppedError,
          });
    this.events.emitIsolated("diagnostic", diagnostic);
  }

  #isPromiseLike(value: unknown): value is PromiseLike<void | (() => void)> {
    return (
      (typeof value === "object" && value !== null && "then" in value) ||
      (typeof value === "function" && "then" in value)
    );
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
   * メッセージを1件送信し、selector に一致する受信メッセージを購読します。初期化中の場合は ready になるまで送信を待ちます。
   *
   * @returns 購読を解除する関数を返します
   *
   * @throws {UniplsInvalidUsageError} active な open intent がない場合に同期的に投げます。
   * @throws {RangeError} `timeout` が有限の正数でない場合に同期的に投げます。
   */
  subscribe(
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    return this.#subscribe(params, { type: "ready" });
  }

  /**
   * {@link Unipls.subscribe} と同じですが、WebSocket が開いた時点で初期化の完了を待たずに送信します。
   */
  subscribeForce(
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    return this.#subscribe(params, this.#activeTransportMode());
  }

  #subscribe(
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
    mode: MessageDeliveryMode,
  ): () => void {
    const query = params.query;
    const selector = params.selector;
    const terminator = params.terminator ?? (() => false);
    const signal = params.signal;
    const timeout = params.timeout;
    const retry = params.retry;
    const predicateError = params.predicateError ?? "continue";
    validateOperationTimeout(timeout);
    if (signal?.aborted) throw signal.reason;
    const session = this.#lifecycle.acceptOperation();

    let scope!: StreamOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>;
    let requestSession!: QuerySession<TInput, TOutput>;
    scope = new StreamOperationScope<TOutput, TOutput, UniplsEvents<TOutput>>({
      events: this.events,
      dispatcher: this.#messages,
      session,
      operationType: "subscribe",
      mode,
      receive: (message) => {
        if (!requestSession.sent) return;
        const terminatorResult = this.#processMessage({
          scope,
          message,
          predicate: terminator,
          predicateType: "terminator",
          policy: predicateError,
          onSelected: scope.handleTerminator,
          onPredicateFailure: scope.raiseFatalError,
        });
        if (terminatorResult !== "unmatched") return;
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
      subscriber: params,
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
      query: UniplsMessageFactory<TInput>,
      { selector }: { selector: (data: TOutput) => boolean },
    ) => {
      requestSession.send(query, {
        selector,
        isDone: () => scope.resulted,
      });
    };

    const sendInitial = () => {
      if (!requestSession.sent) request(query, { selector });
    };
    if (mode.type === "transport" || this.#isSessionReady(session)) sendInitial();
    else {
      events.on("open", ({ session: openedSession }) => {
        if (openedSession === session) sendInitial();
      });
    }

    const onReconnected = createOnReconnectedHandler({
      events,
      isDone: () => scope.resulted,
      reset: () => requestSession.resetForReconnect(),
      request,
      onError: scope.raiseFatalError,
    });

    const onDropped = createRetryingDropHandler({
      reconnectable: this.#reconnector !== undefined,
      retry,
      isDone: () => scope.resulted,
      onFatal: scope.raiseFatalError,
      onReconnected,
      getQuery: () => requestSession.currentQuery,
      getSelector: () => requestSession.currentSelector,
    });
    events.on("dropped", (event) => {
      if (event.session === scope.session) onDropped(event);
    });

    events.on("closed", ({ session: closedSession, error }) => {
      if (closedSession !== scope.session) return;
      scope.raiseFatalError(error ?? new UniplsClosedError());
    });

    return scope.unsubscribe;
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

  #activeTransportMode(): MessageDeliveryMode {
    const snapshot = this.#lifecycle.snapshot;
    if (
      snapshot.phase === "open" ||
      snapshot.phase === "provisioning" ||
      (snapshot.phase === "connecting" && snapshot.status === "attempting")
    ) {
      return { type: "transport", connection: snapshot.connection };
    }
    throw new UniplsInvalidUsageError(
      "この操作は有効な WebSocket 接続試行の内側でのみ開始できます。",
    );
  }

  #isSessionReady(session: SessionId): boolean {
    const snapshot = this.#lifecycle.snapshot;
    return snapshot.phase === "open" && snapshot.session === session;
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
      operation: import("./types.ts").OperationId;
      operationType: import("./types.ts").OperationType;
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
      if (policy === "fail") onPredicateFailure(cause);
      const diagnostic: MessagePredicateFailedDiagnostic = Object.freeze({
        type: "message-predicate-failed",
        severity: "error",
        scope: Object.freeze({
          type: "operation",
          session: scope.session,
          operation: scope.operation,
          operationType: scope.operationType,
        }),
        occurredAt: Date.now(),
        cause,
        predicate: predicateType,
        policy,
      });
      this.events.emitIsolated("diagnostic", diagnostic);
      return "failed";
    }
    if (!selected) return "unmatched";
    try {
      onSelected(message);
    } catch (cause) {
      console.warn("メッセージ callback でエラーが発生しました:", cause);
    }
    return "matched";
  }
}
