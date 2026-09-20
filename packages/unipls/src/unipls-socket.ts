import { AsyncResult } from "./async-result.ts";
import {
  UniplsInvalidUsageError,
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
 * 1つの WebSocket 接続を開閉し、値の変換と drop の分類を行う低レベル client です。
 * 論理セッションや自動回復が必要な場合は {@link Unipls} を利用してください。
 */
export class UniplsSocket<TInput = WebSocketData, TOutput = WebSocketData> {
  #url: string;
  /** 接続先の WebSocket URL です。 */
  get url(): string {
    return this.#url;
  }
  /** 送信値を WebSocket が扱えるデータへ変換します。 */
  protected serialize: (data: TInput) => WebSocketData;
  /** 受信した WebSocket データを利用者向けの値へ変換します。 */
  protected deserialize: (data: WebSocketData) => TOutput;
  /** WebSocket 接続の成立を待つ最大時間です。 */
  protected timeout: number;
  #WebSocket: WebSocketConstructor;
  #epoch: UniplsTransportEpoch = UniplsTransportEpoch.dead();
  #events = new EventBus<UniplsSocketPublicEvents<TOutput> & UniplsSocketInternalEvents>();
  /** 接続単位のイベントを購読する event bus です。 */
  get events(): EventBus<UniplsSocketPublicEvents<TOutput>> {
    return this.#events as EventBus<UniplsSocketPublicEvents<TOutput>>;
  }
  /** 現在の WebSocket 接続状態です。 */
  get state(): UniplsConnectionState {
    return this.#epoch.connection.state;
  }
  /** 利用者が接続の維持と終了のどちらを意図しているかを表します。 */
  get intent() {
    return this.#epoch.intent;
  }
  /** 現在の接続試行を識別する単調増加の番号です。 */
  get transportEpochId() {
    return this.#epoch.id;
  }
  /** 指定した接続試行が現在も有効な場合に `true` を返します。 */
  isCurrentTransportEpoch(epochId: number): boolean {
    return this.#epoch.id === epochId && !this.#epoch.signal.aborted;
  }
  /** 接続先と値の変換方法を指定して低レベル client を作成します。 */
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
      const messageSequence = epoch.nextMessageSequence();
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
          messageSequence,
          input: describeRawInput(data),
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
   * @param provisioner WebSocket が開いた後、`open()` の解決前に行う初期化処理です。
   * @throws {@link UniplsInvalidUsageError} 接続済み、または接続試行中の場合に投げます。
   */
  open(provisioner?: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.intent === "open" && this.state !== "dropped") {
      throw new UniplsInvalidUsageError("WebSocket は既に接続済みか接続試行中です。");
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

  /** 現在の接続を手動で drop として報告します。 */
  drop(epochId = this.#epoch.id): void {
    this.reportDrop(
      epochId,
      { source: { type: "manual-drop" } },
      UniplsWebSocketCloseCode.ABNORMAL_CLOSURE,
    );
  }

  /**
   * 指定した接続試行の drop を同期的に報告します。
   * 最初の報告だけが採用され、同じ接続試行への後続報告は `false` を返します。
   */
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

  /** 指定した接続試行で採用された drop 報告を返します。 */
  getDropReport(epochId: number): UniplsSocketDropReport | undefined {
    return this.#epoch.id === epochId ? this.#epoch.dropReport : undefined;
  }

  /** 指定した接続試行を再接続せずに終了します。 */
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

/** `UniplsSocket` が通知する接続単位のイベントです。 */
export interface UniplsSocketPublicEvents<TOutput> {
  /** WebSocket と初期化処理が完了したときの情報です。 */
  open: { epoch: UniplsTransportEpoch };
  /** 変換済みのメッセージを受信したときの情報です。 */
  message: { epoch: UniplsTransportEpoch; message: TOutput };
  /** メッセージ変換に失敗したときの情報です。 */
  error: {
    epoch: UniplsTransportEpoch;
    error: unknown;
    messageSequence: number;
    input: UniplsSocketInputMetadata;
  };
  /** 明示的な close が完了したときの情報です。 */
  closed: { epoch: UniplsTransportEpoch; close?: Readonly<UniplsSocketCloseMetadata> };
  /** open intent 中に接続を失ったときの情報です。 */
  dropped: { epoch: UniplsTransportEpoch; report: UniplsSocketDropReport };
  /** 初期化処理に失敗したときの情報です。 */
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

/** WebSocket の close event から保持する安全なメタデータです。 */
export interface UniplsSocketCloseMetadata {
  /** WebSocket close code です。 */
  readonly code: number;
  /** peer が通知した close reason です。信頼済みのメッセージとしては扱いません。 */
  readonly reason: string;
  /** WebSocket 実装が clean close と判定したかを表します。 */
  readonly wasClean: boolean;
}

/** 低レベルの検出経路が同期 drop gate へ渡す報告です。 */
export interface UniplsSocketDropReport {
  /** drop の検出元です。 */
  readonly source: UniplsDropSource;
  /** peer close に付随するメタデータです。 */
  readonly close?: Readonly<UniplsSocketCloseMetadata>;
  /** 検出に関連する元の例外または値です。 */
  readonly cause?: unknown;
}

/** 変換に失敗した受信データについて公開できる安全なメタデータです。 */
export interface UniplsSocketInputMetadata {
  readonly kind: "text" | "array-buffer" | "typed-array" | "blob";
  readonly size?: number;
}

type UniplsProvisioner = (signal: AbortSignal) => Promise<void>;

/** @internal 1回の WebSocket 接続試行に属する状態と callback をまとめます。 */
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
  #messageSequence = 0;
  get dropReport(): UniplsSocketDropReport | undefined {
    return this.#dropReport;
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  nextMessageSequence(): number {
    this.#messageSequence += 1;
    return this.#messageSequence;
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
            detector: report.source.detector,
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

function describeRawInput(data: WebSocketData): Readonly<UniplsSocketInputMetadata> {
  if (typeof data === "string") {
    return Object.freeze({ kind: "text", size: new TextEncoder().encode(data).byteLength });
  }
  if (data instanceof ArrayBuffer) {
    return Object.freeze({ kind: "array-buffer", size: data.byteLength });
  }
  if (ArrayBuffer.isView(data)) {
    return Object.freeze({ kind: "typed-array", size: data.byteLength });
  }
  if ("size" in data) {
    return Object.freeze({ kind: "blob", size: data.size });
  }
  return Object.freeze({ kind: "array-buffer", size: data.byteLength });
}

/** @internal 1回の接続試行が所有する WebSocket と状態を保持します。 */
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

/** Unipls が WebSocket の close request に使用する code です。 */
export const UniplsWebSocketCloseCode = {
  /**
   * RFC 6455 が定義する正常終了の code です。
   * @see https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1
   */
  NORMAL_CLOSURE: 1000,
  /**
   * 回復不能な drop を peer へ通知するためのライブラリ固有 code です。
   * @see https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.2
   */
  IRRECOVERABLE_DROP: 3000,
  /**
   * 1006 はクライアントサイドからは送信できないため、代わりに 3001 を使用します。
   */
  ABNORMAL_CLOSURE: 3001,
  /** 接続試行の timeout を peer へ通知するためのライブラリ固有 code です。 */
  MARKED_AS_TIMED_OUT: 3002,
} as const;

const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
