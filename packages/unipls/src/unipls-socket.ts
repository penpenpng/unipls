import { AsyncResult } from "./async-result.ts";
import {
  UniplsDuplicatedConnectionError,
  UniplsSocketClosedError,
  UniplsSocketDroppedError,
  UniplsTimeoutError,
} from "./errors.ts";
import { EventBus } from "./event-bus.ts";
import type {
  UniplsConnectionIntent,
  UniplsConnectionState,
  UniplsDropSource,
  WebSocketConstructor,
  WebSocketData,
} from "./types.ts";
import type { UniplsParams } from "./unipls.interface.ts";

/**
 * 基礎的な機能を備えた WebSocket クライアントです。
 *
 * - コネクションプロビジョニング
 * - 同インスタンス上での (手動の) 再接続
 * - メッセージのシリアライズ/デシリアライズ
 * - drop イベントの検知
 */
export class UniplsSocket<TInput = WebSocketData, TOutput = WebSocketData> {
  #url: string;
  get url(): string {
    return this.#url;
  }
  protected serialize: (data: TInput) => WebSocketData;
  protected deserialize: (data: WebSocketData) => TOutput;
  protected timeout: number;
  #WebSocket: WebSocketConstructor;
  #epoch: UniplsTransportEpoch = UniplsTransportEpoch.dead();
  #events = new EventBus<UniplsSocketPublicEvents<TOutput> & UniplsSocketInternalEvents>();
  get events(): EventBus<UniplsSocketPublicEvents<TOutput>> {
    return this.#events as EventBus<UniplsSocketPublicEvents<TOutput>>;
  }
  get state(): UniplsConnectionState {
    return this.#epoch.connection.state;
  }
  get intent() {
    return this.#epoch.intent;
  }
  get transportEpochId() {
    return this.#epoch.id;
  }
  isCurrentTransportEpoch(epochId: number): boolean {
    return this.#epoch.id === epochId && !this.#epoch.signal.aborted;
  }
  constructor({
    url,
    serializer = (data) => data as WebSocketData,
    deserializer = (data) => data as TOutput,
    WebSocket = globalThis.WebSocket,
    timeout = 5000,
  }: UniplsParams<TInput, TOutput>) {
    this.#url = url;
    this.serialize = serializer;
    this.deserialize = deserializer;
    this.timeout = timeout;

    this.#WebSocket = WebSocket;
    if (!this.#WebSocket) {
      throw new Error("WebSocket constructor was not provided.");
    }

    this.#events.on("raw-open", async ({ epoch }) => {
      if (!this.#isCurrent(epoch)) {
        return;
      }
      epoch.connection.state = "provisioning";

      try {
        await epoch.provisioner?.(epoch.signal);
        if (!this.#isCurrent(epoch)) {
          return;
        }
        epoch.connection.state = "open";
        this.#events.emit("open", { epoch });
      } catch (error) {
        if (!this.#isCurrent(epoch)) {
          return;
        }
        epoch.intent = "close";
        epoch.connection.state = "closed";
        this.#events.emit("failed", { epoch, error });
        epoch.connection.socket?.close(UniplsWebSocketCloseCode.NORMAL_CLOSURE);
        epoch.deactivate(error);
      }
    });

    this.#events.on("raw-message", ({ data, epoch }) => {
      if (!this.#isCurrent(epoch)) {
        return;
      }
      try {
        const message = this.deserialize(data);
        this.#events.emit("message", {
          epoch,
          message,
        });
      } catch (error) {
        this.#events.emit("error", {
          epoch,
          error,
        });
      }
    });

    this.#events.on("raw-error", ({ error, epoch }) => {
      if (!this.#isCurrent(epoch)) {
        return;
      }
      this.reportDrop(
        epoch.id,
        { source: { type: "transport-error" }, cause: error },
        UniplsWebSocketCloseCode.ABNORMAL_CLOSURE,
      );
    });

    this.#events.on("raw-close", ({ epoch, code, reason, wasClean }) => {
      if (!this.#isCurrent(epoch)) {
        return;
      }
      const close = Object.freeze({ code, reason, wasClean });
      if (epoch.intent === "close") {
        epoch.connection.state = "closed";
        epoch.deactivate(new UniplsSocketClosedError());
        this.#events.emit("closed", { epoch, close });
        return;
      }
      this.reportDrop(epoch.id, { source: { type: "peer-close" }, close });
    });
  }

  /**
   * WebSocket 接続が未確立ならば新規の接続を試みて、接続とプロビジョニングに成功したときに解決する Promise を返します。
   *
   * @param {UniplsProvisioner} provisioner WebSocket 接続成功後の初期化処理を定義します。
   *
   * @throws {UniplsDuplicatedConnectionError} WebSocket が既に接続されているか、接続を試行中の場合に例外を投げます。
   */
  open(provisioner?: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.intent === "open" && this.state !== "dropped") {
      throw new UniplsDuplicatedConnectionError();
    }
    this.#epoch.deactivate(new UniplsSocketDroppedError());
    const epoch = UniplsTransportEpoch.create(provisioner);
    epoch.connection.state = "connecting";
    this.#epoch = epoch;

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const events = this.#events.spawnEventBusView();
    const result = new AsyncResult<void>({
      signal: epoch.signal,
      finally: () => {
        events.dispose();
        if (timeoutTimer) clearTimeout(timeoutTimer);
      },
    });

    try {
      epoch.connection.socket = this.#createSocket(epoch);
    } catch (cause) {
      this.reportDrop(epoch.id, { source: { type: "transport-error" }, cause });
      return result.promise;
    }

    events.on("open", (ev) => {
      if (ev.epoch.id !== epoch.id) {
        return;
      }
      result.resolve();
    });
    events.on("closed", (ev) => {
      if (ev.epoch.id !== epoch.id) {
        return;
      }
      result.reject(new UniplsSocketClosedError());
    });
    events.on("dropped", (ev) => {
      if (ev.epoch.id !== epoch.id) {
        return;
      }
      result.reject(new UniplsSocketDroppedError());
    });
    events.on("failed", (ev) => {
      if (ev.epoch.id !== epoch.id) {
        return;
      }
      result.reject(ev.error);
    });

    timeoutTimer = setTimeout(() => {
      if (result.resulted) {
        return;
      }

      timeoutTimer = undefined;
      const cause = new UniplsTimeoutError();
      this.reportDrop(
        epoch.id,
        { source: { type: "timeout" }, cause },
        UniplsWebSocketCloseCode.MARKED_AS_TIMED_OUT,
      );
    }, this.timeout);

    return result.promise;
  }

  #createSocket(epoch: UniplsTransportEpoch): WebSocket {
    const WebSocket = this.#WebSocket;
    const socket = new WebSocket(this.url);

    socket.onopen = () => {
      this.#events.emit("raw-open", { epoch });
    };
    socket.onmessage = (ev) => {
      this.#events.emit("raw-message", { epoch, data: ev.data });
    };
    socket.onerror = (ev) => {
      const cause = "cause" in ev ? ev.cause : ev;
      this.#events.emit("raw-error", { epoch, error: cause });
    };
    socket.onclose = (ev) => {
      this.#events.emit("raw-close", {
        epoch,
        socket,
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean,
      });
    };

    return socket;
  }

  /**
   * WebSocket 接続を切断します。既に切断されている場合は何もしません。
   */
  close(): Promise<void> {
    if (this.intent === "close" || this.state === "closed") {
      return Promise.resolve();
    }

    const targetEpoch = this.#epoch;
    const targetEpochId = targetEpoch.id;
    const socket = targetEpoch.connection.socket;
    targetEpoch.intent = "close";

    if (!socket || this.state === "dropped") {
      targetEpoch.connection.state = "closed";
      targetEpoch.deactivate(new UniplsSocketClosedError());
      this.#events.emit("closed", { epoch: targetEpoch });
      return Promise.resolve();
    }

    const events = this.#events.spawnEventBusView();
    const result = new AsyncResult<void>({
      finally: () => events.dispose(),
    });

    events.on("closed", ({ epoch }) => {
      if (targetEpochId !== epoch.id) return;
      result.resolve();
    });
    events.on("dropped", ({ epoch }) => {
      if (targetEpochId !== epoch.id) return;
      result.resolve();
    });

    socket.close(UniplsWebSocketCloseCode.NORMAL_CLOSURE);

    return result.promise;
  }

  drop(epochId = this.#epoch.id): void {
    this.reportDrop(
      epochId,
      { source: { type: "manual-drop" } },
      UniplsWebSocketCloseCode.ABNORMAL_CLOSURE,
    );
  }

  reportDrop(
    epochId: number,
    report: UniplsSocketDropReport,
    closeCode: number = UniplsWebSocketCloseCode.ABNORMAL_CLOSURE,
  ): boolean {
    const epoch = this.#epoch;
    if (epoch.id !== epochId || !epoch.claimDrop(report)) {
      return false;
    }

    const frozenReport = epoch.dropReport as UniplsSocketDropReport;
    const socket = epoch.connection.socket;
    epoch.connection.state = "dropped";
    epoch.deactivate(frozenReport.cause ?? new UniplsSocketDroppedError());
    if (socket && socket.readyState < WebSocketReadyState.CLOSING) {
      socket.close(closeCode);
    }
    this.#events.emit("dropped", { epoch, report: frozenReport });
    return true;
  }

  getDropReport(epochId: number): UniplsSocketDropReport | undefined {
    return this.#epoch.id === epochId ? this.#epoch.dropReport : undefined;
  }

  terminate(epochId: number): void {
    if (this.#epoch.id !== epochId) {
      return;
    }
    const epoch = this.#epoch;
    const socket = epoch.connection.socket;
    epoch.intent = "close";
    epoch.connection.state = "closed";
    epoch.deactivate(new UniplsSocketClosedError());
    if (socket && socket.readyState < WebSocketReadyState.CLOSING) {
      socket.close(UniplsWebSocketCloseCode.NORMAL_CLOSURE);
    }
  }

  /**
   * 現在の接続状態が `"connecting"`, `"provisioning"`, `"open"` のいずれかであるとき、接続状態が `"open"` になるのを待ってからデータを送信します。
   * 接続が drop または close されたとしても、再送信は試みられません。
   */
  enqueue(data: TInput, options?: { signal?: AbortSignal; force?: boolean }): Promise<void> {
    const epoch = this.#epoch;
    const socket = epoch.connection.socket;
    const signal = options?.signal ? AbortSignal.any([epoch.signal, options.signal]) : epoch.signal;
    const events = this.#events.spawnEventBusView();
    const result = new AsyncResult<void>({
      signal,
      finally: () => events.dispose(),
    });

    const send = () => {
      if (!this.#isCurrent(epoch)) {
        result.reject(epoch.signal.reason ?? new UniplsSocketDroppedError());
        return;
      }
      if (!socket || socket.readyState !== WebSocketReadyState.OPEN) {
        result.reject(new UniplsSocketClosedError());
        return;
      }

      try {
        socket.send(this.serialize(data));
        result.resolve();
      } catch (error) {
        result.reject(error);
      }
    };

    if (!socket || epoch.connection.state === "closed" || epoch.intent === "close") {
      result.reject(new UniplsSocketClosedError());
      return result.promise;
    }

    if (epoch.connection.state === "dropped") {
      result.reject(new UniplsSocketDroppedError());
      return result.promise;
    }

    if (signal.aborted) {
      result.reject(signal.reason);
      return result.promise;
    }

    if (
      (epoch.connection.state === "open" ||
        (epoch.connection.state === "provisioning" && options?.force)) &&
      socket.readyState === WebSocketReadyState.OPEN
    ) {
      send();
      return result.promise;
    }

    if (options?.force) {
      events.on(
        "raw-open",
        ({ epoch: openedEpoch }) => {
          if (openedEpoch.id !== epoch.id) return;
          send();
        },
        { once: true },
      );
    } else {
      events.on(
        "open",
        ({ epoch: openedEpoch }) => {
          if (openedEpoch.id !== epoch.id) return;
          send();
        },
        { once: true },
      );
    }
    events.on(
      "closed",
      ({ epoch: closedEpoch }) => {
        if (closedEpoch.id !== epoch.id) return;
        result.reject(new UniplsSocketClosedError());
      },
      { once: true },
    );
    events.on(
      "dropped",
      ({ epoch: droppedEpoch }) => {
        if (droppedEpoch.id !== epoch.id) return;
        result.reject(new UniplsSocketDroppedError());
      },
      { once: true },
    );
    events.on(
      "failed",
      ({ epoch: failedEpoch, error }) => {
        if (failedEpoch.id !== epoch.id) return;
        result.reject(error);
      },
      { once: true },
    );

    return result.promise;
  }

  #isCurrent(epoch: UniplsTransportEpoch): boolean {
    return this.#epoch === epoch && !epoch.signal.aborted;
  }
}

export interface UniplsSocketPublicEvents<TOutput> {
  open: { epoch: UniplsTransportEpoch };
  message: { epoch: UniplsTransportEpoch; message: TOutput };
  error: { epoch: UniplsTransportEpoch; error: unknown };
  closed: { epoch: UniplsTransportEpoch; close?: Readonly<UniplsSocketCloseMetadata> };
  dropped: { epoch: UniplsTransportEpoch; report: UniplsSocketDropReport };
  failed: { epoch: UniplsTransportEpoch; error: unknown };
}

interface UniplsSocketInternalEvents {
  "raw-open": { epoch: UniplsTransportEpoch };
  "raw-message": { epoch: UniplsTransportEpoch; data: WebSocketData };
  "raw-error": { epoch: UniplsTransportEpoch; error: unknown };
  "raw-close": {
    epoch: UniplsTransportEpoch;
    socket: WebSocket;
    code: number;
    reason: string;
    wasClean: boolean;
  };
}

export interface UniplsSocketCloseMetadata {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export interface UniplsSocketDropReport {
  readonly source: UniplsDropSource;
  readonly close?: Readonly<UniplsSocketCloseMetadata>;
  readonly cause?: unknown;
}

type UniplsProvisioner = (signal: AbortSignal) => Promise<void>;

// FIXME: ドメインを記述する
class UniplsTransportEpoch {
  static #nextEpochId = 1;

  #id: number;
  get id() {
    return this.#id;
  }

  #provisioner?: UniplsProvisioner;
  get provisioner() {
    return this.#provisioner;
  }

  intent: UniplsConnectionIntent = "open";
  connection: UniplsTransportConnection;
  readonly #controller = new AbortController();
  #dropReport?: UniplsSocketDropReport;
  get dropReport(): UniplsSocketDropReport | undefined {
    return this.#dropReport;
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  deactivate(reason: unknown): void {
    if (!this.signal.aborted) {
      this.#controller.abort(reason);
    }
    this.connection.detach();
  }

  claimDrop(report: UniplsSocketDropReport): boolean {
    if (this.intent === "close" || this.#dropReport || this.signal.aborted) {
      return false;
    }
    const source =
      report.source.type === "detector"
        ? Object.freeze({
            type: "detector" as const,
            detector: Object.freeze({ ...report.source.detector }),
          })
        : Object.freeze({ ...report.source });
    this.#dropReport = Object.freeze({
      source,
      ...(report.close ? { close: Object.freeze({ ...report.close }) } : {}),
      ...(report.cause === undefined ? {} : { cause: report.cause }),
    });
    return true;
  }

  static create(provisioner?: UniplsProvisioner) {
    return new UniplsTransportEpoch(this.#nextEpochId++, provisioner);
  }

  static dead() {
    const epoch = new UniplsTransportEpoch(NaN);
    epoch.intent = "close";
    epoch.connection.state = "closed";
    epoch.deactivate(new UniplsSocketClosedError());
    return epoch;
  }

  private constructor(epochId: number, provisioner?: UniplsProvisioner) {
    this.#id = epochId;
    this.#provisioner = provisioner;
    this.connection = new UniplsTransportConnection(epochId);
  }
}

class UniplsTransportConnection {
  state: UniplsConnectionState = "closed";
  socket?: WebSocket;

  detach(): void {
    if (!this.socket) {
      return;
    }
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
  }

  constructor(public epochId: number) {}
}

export const UniplsWebSocketCloseCode = {
  /**
   * 1000 indicates a normal closure, meaning that the purpose for
   * which the connection was established has been fulfilled.
   *
   * See also: https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1
   */
  NORMAL_CLOSURE: 1000,
  /**
   * Status codes in the range 3000-3999 are reserved for use by
   * libraries, frameworks, and applications.  These status codes are
   * registered directly with IANA.  The interpretation of these codes
   * is undefined by this protocol.
   *
   * See also: https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.2
   */
  IRRECOVERABLE_DROP: 3000,
  /**
   * 1006 はクライアントサイドからは送信できないため、代わりに 3001 を使用します。
   */
  ABNORMAL_CLOSURE: 3001,
  MARKED_AS_TIMED_OUT: 3002,
} as const;

const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
