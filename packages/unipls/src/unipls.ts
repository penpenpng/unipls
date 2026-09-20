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
  DropDetectorIdentity,
  SessionId,
  UniplsConnectionState,
  UniplsDrop,
  UniplsDroppedErrorOutcome,
  UniplsLifecycleSnapshot,
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

type UniplsEvents<TOutput> = {
  /** 接続が ready になったときに通知されます。 */
  open: ConnectionEventContext;
  /** メッセージを受信して変換できたときに通知されます。 */
  message: ConnectionEventContext & { message: TOutput };
  /** 受信メッセージの変換など、継続可能な処理が失敗したときに通知されます。 */
  error: ConnectionEventContext & { error: unknown };
  /** 論理セッションが終了したときに通知されます。 */
  closed: ConnectionEventContext & { error?: UniplsDroppedError };
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
};

/** 論理セッションを維持しながら WebSocket の送受信と回復を管理する client です。 */
export class Unipls<TInput = WebSocketData, TOutput = WebSocketData> {
  #socket: UniplsSocket<TInput, TOutput>;
  #events = new EventBus<UniplsEvents<TOutput>>();
  #transportContexts = new Map<number, ConnectionEventContext>();
  #canonicalDrops = new Map<number, UniplsDrop>();
  #provisioner?: UniplsProvisioner<TInput, TOutput>;
  #reconnector?: UniplsReconnector;
  #reconnectorCleanup?: () => void;
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
        const cause = this.#translateSocketError(error);
        if (!this.#lifecycle.isCurrentAttempt(connection)) {
          throw cause;
        }
        const stage = this.lifecycle.phase === "provisioning" ? "provisioning" : "connecting";
        const drop = this.#canonicalDrops.get(transportEpochId);
        const attempts = this.#lifecycle.failInitialAttempt(connection, cause, drop);
        this.#canonicalDrops.delete(transportEpochId);
        throw new UniplsOpenError({
          outcome: "attempt-failed",
          stage,
          attempts,
          cause,
          drop,
        });
      });
    void promise.catch(() => {});
    return promise;
  }

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    const context = this.#activeSessionContext();
    this.#transportContexts.clear();
    const closing = this.#socket.close();
    this.#lifecycle.closeByUser();
    this.#detectorManager.stop();
    this.#reconnectorCleanup?.();
    this.#reconnectorCleanup = undefined;
    this.#canonicalDrops.clear();
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
          // resolve は例外を投げないため追加処理は不要です。
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

    events.on(
      "closed",
      ({ error }) => {
        scope.reject(error ?? new UniplsClosedError());
      },
      { once: true },
    );

    return scope.promise;
  }

  /**
   * selector に一致する受信メッセージを購読します。
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
    events.on(
      "closed",
      ({ error }) => {
        scope.raiseFatalError(error ?? new UniplsClosedError());
      },
      { once: true },
    );

    return scope.unsubscribe;
  }

  /**
   * 1件のメッセージを送信します。初期化中の場合は ready になるまで送信を待ちます。
   *
   * @returns メッセージの送信が完了すると解決する Promise です。
   *
   * @throws {UniplsClosedError}
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
   * @throws {UniplsClosedError}
   * @throws {UniplsTimeoutError}
   */
  request(params: UniplsRequestParams<TInput, TOutput>): Promise<TOutput> {
    return this.#request({ ...params, force: false });
  }

  /**
   * {@link Unipls.request} と同じですが、WebSocket が開いた時点で初期化の完了を待たずに送信します。
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
          // resolve は例外を投げないため追加処理は不要です。
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

    events.on(
      "closed",
      ({ error }) => {
        scope.reject(error ?? new UniplsClosedError());
      },
      { once: true },
    );

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
            scope.reject(this.#translateSocketError(error));
          });
      };

      if (this.state === "open" || (this.state === "provisioning" && force)) {
        enqueueEvaluatedPayload();
        return;
      }

      if (force) {
        events.on("open", enqueueEvaluatedPayload, { once: true });
      } else {
        events.on("open", enqueueEvaluatedPayload, { once: true });
      }
    };

    if (this.state === "connecting" || this.state === "provisioning" || this.state === "open") {
      sendOnce(params.query);
    }

    events.on(
      "closed",
      ({ error }) => {
        scope.reject(error ?? new UniplsClosedError());
      },
      { once: true },
    );

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
          this.#detectorManager.start(transportEpochId, (identity) =>
            this.#createDropDetectorContext(transportEpochId, signal, identity),
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
        this.#canonicalDrops.delete(epochId);
      } catch (err) {
        const cause = this.#translateSocketError(err);
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
      this.#terminateRecovery("recovery-cancelled");
    };

    const exhaust = (cause?: unknown) => {
      if (settled) {
        return;
      }
      cleanup();
      this.#terminateRecovery("recovery-exhausted", cause);
    };

    let registeredCleanup: (() => void) | undefined;

    try {
      const cleanupCallback = this.#reconnector.setup(
        {
          reconnect,
          cancel,
          exhaust,
        },
        this.#lifecycle.buildReconnectionContext(),
      );
      registeredCleanup = cleanupCallback ?? undefined;
      if (settled) {
        registeredCleanup?.();
        return;
      }
      this.#reconnectorCleanup = cleanup;
    } catch (cause) {
      cleanup();
      this.#terminateRecovery("reconnector-failed", cause);
      return;
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

    if (!this.#lifecycle.hasBeenReady) {
      const error = new UniplsDroppedError({
        outcome: "operation-failed",
        drop,
        attempts: this.#lifecycle.attempts,
        cause: report.cause,
      });
      this.events.emit("dropped", { ...context, drop, error });
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
    void this.#handleDropped(transportEpochId);
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
    this.#reconnectorCleanup?.();
    this.#reconnectorCleanup = undefined;
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
   * @throws {UniplsClosedError}
   */
  subscribe(
    params: UniplsSubscriber<TOutput> & UniplsSubscribeParams<TInput, TOutput>,
  ): () => void {
    return this.#subscribe(params, false);
  }

  /**
   * {@link Unipls.subscribe} と同じですが、WebSocket が開いた時点で初期化の完了を待たずに送信します。
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

    events.on(
      "closed",
      ({ error }) => {
        scope.raiseFatalError(error ?? new UniplsClosedError());
      },
      { once: true },
    );

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
