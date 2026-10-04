/** WebSocket が送受信できるblob形式のbinary dataに必要な公開形です。 */
export interface WebSocketBlob {
  /** dataのbyte数です。 */
  readonly size: number;
  /** dataのMIME typeです。 */
  readonly type?: string;
}

/** WebSocket によって送受信することができるデータを表します。 */
export type WebSocketData = string | ArrayBufferLike | WebSocketBlob | ArrayBufferView;

/** WebSocketが接続を確立したときのeventに必要な公開形です。 */
export interface WebSocketOpenEvent {
  readonly type?: string;
}

/** WebSocketがmessageを受信したときのeventに必要な公開形です。 */
export interface WebSocketMessageEvent {
  readonly data: WebSocketData;
}

/** WebSocketがtransport errorを通知したときのeventに必要な公開形です。 */
export interface WebSocketErrorEvent {
  readonly type?: string;
  readonly cause?: unknown;
}

/** WebSocketが接続終了を通知したときのeventに必要な公開形です。 */
export interface WebSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/** WebSocket実装がevent propertyへ受け付けるlistenerです。 */
export type WebSocketEventListener<TEvent> = {
  bivarianceHack(event: TEvent): unknown;
}["bivarianceHack"];

/** uniplsが通信に使用するWebSocket instanceの最小interfaceです。 */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: WebSocketEventListener<WebSocketOpenEvent> | null;
  onmessage: WebSocketEventListener<WebSocketMessageEvent> | null;
  onerror: WebSocketEventListener<WebSocketErrorEvent> | null;
  onclose: WebSocketEventListener<WebSocketCloseEvent> | null;
  send(data: WebSocketData): void;
  close(code?: number, reason?: string): void;
}

declare const sessionIdBrand: unique symbol;
declare const connectionIdBrand: unique symbol;
declare const operationIdBrand: unique symbol;

/** `open()` から終了まで維持される論理セッションの識別子です。 */
export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };

/** 1回の WebSocket 接続試行を識別する値です。 */
export type ConnectionId = string & { readonly [connectionIdBrand]: "ConnectionId" };

/** 1回の通信操作を識別する値です。 */
export type OperationId = string & { readonly [operationIdBrand]: "OperationId" };

/** 通信操作の公開 API 上の種類です。 */
export type OperationType = "cast" | "next" | "request" | "listen" | "subscribe";

/** selector または terminator が例外を投げた場合の扱いです。 */
export type PredicateErrorPolicy = "continue" | "fail";

/** Unipls が WebSocket を生成するときに使用するコンストラクターです。 */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** 現在の WebSocket 接続の状態です。 */
export type UniplsConnectionState = "connecting" | "provisioning" | "open" | "closed" | "dropped";

/** 利用者が接続の維持と終了のどちらを意図しているかを表します。 */
export type UniplsConnectionIntent = "open" | "close";

/** 接続試行が初回接続と回復接続のどちらに属するかを表します。 */
export type ConnectionAttemptOrigin = "initial" | "recovery";

/** 接続試行が WebSocket 接続中と初期化中のどちらで失敗したかを表します。 */
export type ConnectionAttemptStage = "connecting" | "provisioning";

/** drop detector を登録順と任意の名前で識別する不変の情報です。 */
export interface DropDetectorIdentity {
  /** `dropDetectors` に指定した0始まりの位置です。 */
  readonly registrationIndex: number;
  /** detector が宣言した診断用の名前です。 */
  readonly name?: string;
}

/** 1回の接続試行が確定した時点の不変な記録です。 */
export type ConnectionAttemptSnapshot =
  | Readonly<{
      sequence: number;
      cycle: number;
      attempt: number;
      origin: ConnectionAttemptOrigin;
      connection: ConnectionId;
      startedAt: number;
      endedAt: number;
      outcome: "ready";
    }>
  | Readonly<{
      sequence: number;
      cycle: number;
      attempt: number;
      origin: ConnectionAttemptOrigin;
      connection: ConnectionId;
      startedAt: number;
      endedAt: number;
      outcome: "failed";
      stage: ConnectionAttemptStage;
      cause: unknown;
      drop?: UniplsDrop;
    }>
  | Readonly<{
      sequence: number;
      cycle: number;
      attempt: number;
      origin: ConnectionAttemptOrigin;
      connection: ConnectionId;
      startedAt: number;
      endedAt: number;
      outcome: "aborted";
      stage: ConnectionAttemptStage;
      reason: "session-closed";
    }>;

/** drop の診断情報として保存できる JSON 互換の値です。 */
export type DropMetadataValue =
  | null
  | boolean
  | number
  | string
  | readonly DropMetadataValue[]
  | { readonly [key: string]: DropMetadataValue };

/** detector が報告する安定した理由と追加の診断情報です。 */
export interface DropDetectorReport {
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, DropMetadataValue>>;
}

/** 接続が失われたことを最初に報告した検出元です。 */
export type UniplsDropSource =
  | Readonly<{ type: "peer-close" }>
  | Readonly<{ type: "transport-error" }>
  | Readonly<{ type: "timeout" }>
  | Readonly<{ type: "detector"; detector: DropDetectorIdentity } & DropDetectorReport>
  | Readonly<{ type: "manual-drop" }>;

/** 論理セッション内で接続が失われた事実を表す不変な記録です。 */
export interface UniplsDrop {
  /** drop を確定させた検出元です。 */
  readonly source: UniplsDropSource;
  /** drop が属する論理セッションです。 */
  readonly session: SessionId;
  /** drop が発生した接続試行です。 */
  readonly connection: ConnectionId;
  /** drop を検出した Unix epoch ミリ秒です。 */
  readonly detectedAt: number;
  /** peer close が検出元の場合に保持する WebSocket close 情報です。 */
  readonly close?: Readonly<{
    code: number;
    reason: string;
    wasClean: boolean;
  }>;
  /** drop の検出に関連する元の例外または値です。 */
  readonly cause?: unknown;
}

/** `open()` が論理セッションを ready にできなかった結果です。 */
export type UniplsOpenErrorOutcome =
  | "attempt-failed"
  | "attempts-cancelled"
  | "attempts-exhausted"
  | "reconnector-failed";

/** ready だった論理セッションを維持できなかった結果です。 */
export type UniplsDroppedErrorOutcome =
  | "operation-failed"
  | "recovery-cancelled"
  | "recovery-exhausted"
  | "reconnector-failed";

/** 再接続エンジンが1回の判断を確定した結果です。 */
export type ReconnectionEngineOutcome =
  | "retrying"
  | "succeeded"
  | "cancelled"
  | "exhausted"
  | "reconnector-failed"
  | "session-closed";

/** @internal resource ownership とログ相関に使用する scope です。 */
export type UniplsResourceScope =
  | Readonly<{ type: "session"; session: SessionId }>
  | Readonly<{
      type: "connection";
      session: SessionId;
      connection: ConnectionId;
      messageSequence?: number;
    }>
  | Readonly<{
      type: "operation";
      session: SessionId;
      operation: OperationId;
      operationType: OperationType;
    }>;

/** Unipls が出力するログの重要度です。 */
export type UniplsLogLevel = "debug" | "info" | "warning" | "error";

/** ログの相関と追加情報を保持する context です。 */
export type UniplsLogContext = Readonly<{
  session?: SessionId;
  connection?: ConnectionId;
  operation?: OperationId;
  operationType?: OperationType;
  [key: string]: unknown;
}>;

/** Unipls が log sink へ同期的に渡す構造化ログです。 */
export interface UniplsLog {
  readonly level: UniplsLogLevel;
  readonly event: string;
  readonly message: string;
  readonly context?: UniplsLogContext;
  readonly cause?: unknown;
}

/** 終了した論理セッション、または未開始状態を表す不変なスナップショットです。 */
export type ClosedLifecycleSnapshot =
  | Readonly<{ phase: "closed"; reason: "idle" }>
  | Readonly<{
      phase: "closed";
      reason: "user";
      session: SessionId;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>
  | Readonly<{
      phase: "closed";
      reason: "open-failed";
      session: SessionId;
      outcome: UniplsOpenErrorOutcome;
      attempts: readonly ConnectionAttemptSnapshot[];
      cause: unknown;
      drop?: UniplsDrop;
    }>
  | Readonly<{
      phase: "closed";
      reason: "dropped";
      session: SessionId;
      outcome: Exclude<UniplsDroppedErrorOutcome, "operation-failed">;
      attempts: readonly ConnectionAttemptSnapshot[];
      drop: UniplsDrop;
      cause?: unknown;
    }>;

type AttemptingLifecycleFields = Readonly<{
  status: "attempting";
  session: SessionId;
  connection: ConnectionId;
  cycle: number;
  attempt: number;
  attempts: readonly ConnectionAttemptSnapshot[];
}> &
  (Readonly<{ origin: "initial" }> | Readonly<{ origin: "recovery"; drop: UniplsDrop }>);

/** 論理セッションの現在状態を表す不変なスナップショットです。 */
export type UniplsLifecycleSnapshot =
  | ClosedLifecycleSnapshot
  | Readonly<{
      phase: "connecting";
      status: "waiting";
      session: SessionId;
      origin: "initial";
      nextAttempt: number;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>
  | (Readonly<{ phase: "connecting" }> & AttemptingLifecycleFields)
  | (Readonly<{ phase: "provisioning" }> & AttemptingLifecycleFields)
  | Readonly<{
      phase: "open";
      session: SessionId;
      connection: ConnectionId;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>
  | Readonly<{
      phase: "recovering";
      session: SessionId;
      drop: UniplsDrop;
      nextAttempt: number;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>;

/** lifecycle が遷移した直前と直後のスナップショットです。 */
export interface UniplsLifecycleEvent {
  /** 遷移前のスナップショットです。 */
  readonly previous: UniplsLifecycleSnapshot;
  /** 遷移後のスナップショットです。 */
  readonly current: UniplsLifecycleSnapshot;
}
