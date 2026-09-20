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

/** 接続が失われたことを最初に報告した検出元です。 */
export type UniplsDropSource =
  | Readonly<{ type: "peer-close" }>
  | Readonly<{ type: "transport-error" }>
  | Readonly<{ type: "timeout" }>
  | Readonly<{ type: "detector"; detector: DropDetectorIdentity }>
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

/** 診断情報が属する公開リソースの範囲です。 */
export type UniplsDiagnosticScope =
  | Readonly<{
      type: "session";
      session: SessionId;
    }>
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

/** 受信メッセージの変換に失敗したことを通知する診断情報です。 */
export type MessageDeserializationFailedDiagnostic = Readonly<{
  type: "message-deserialization-failed";
  severity: "warning";
  scope: Extract<UniplsDiagnosticScope, { type: "connection" }>;
  occurredAt: number;
  cause: unknown;
  input: Readonly<{
    kind: "text" | "array-buffer" | "typed-array" | "blob";
    size?: number;
  }>;
}>;

/** operation の selector または terminator が失敗したことを通知する診断情報です。 */
export type MessagePredicateFailedDiagnostic = Readonly<{
  type: "message-predicate-failed";
  severity: "error";
  scope: Extract<UniplsDiagnosticScope, { type: "operation" }>;
  occurredAt: number;
  cause: unknown;
  predicate: "selector" | "terminator";
  policy: PredicateErrorPolicy;
}>;

/** stream の callback が同期的に失敗したことを通知する診断情報です。 */
export type StreamCallbackFailedDiagnostic = Readonly<{
  type: "stream-callback-failed";
  severity: "error";
  scope: Extract<UniplsDiagnosticScope, { type: "operation" }>;
  occurredAt: number;
  cause: unknown;
  policy: import("./async-results.ts").StreamCallbackErrorPolicy;
}>;

/** lossy buffer policy によってメッセージを破棄したことを通知する診断情報です。 */
export type StreamMessageDroppedDiagnostic = Readonly<{
  type: "stream-message-dropped";
  severity: "warning";
  scope: Extract<UniplsDiagnosticScope, { type: "operation" }>;
  occurredAt: number;
  strategy: "latest" | "drop-oldest" | "drop-newest";
  capacity: number;
}>;

/** resource の解放処理が失敗したことを通知する診断情報です。 */
export type ResourceCleanupFailedDiagnostic = Readonly<{
  type: "resource-cleanup-failed";
  severity: "error";
  scope: UniplsDiagnosticScope;
  occurredAt: number;
  cause: unknown;
  resource: Readonly<{
    name?: string;
    source: import("./resource-scope.ts").ResourceRegistrationSource;
  }>;
}>;

/** drop detector の監督対象 callback または task が失敗したことを通知する診断情報です。 */
export type DropDetectorFailedDiagnostic = Readonly<{
  type: "drop-detector-failed";
  severity: "error";
  scope: Extract<UniplsDiagnosticScope, { type: "connection" }>;
  occurredAt: number;
  cause: unknown;
  detector: DropDetectorIdentity;
  boundary: "guard" | "run";
}>;

/** reconnector の実行に失敗したことを通知する診断情報です。 */
export type ReconnectorFailedDiagnostic =
  | Readonly<{
      type: "reconnector-failed";
      severity: "error";
      scope: Extract<UniplsDiagnosticScope, { type: "session" }>;
      occurredAt: number;
      context: "initial-open";
      failurePoint: "setup" | "policy";
      cause: unknown;
      error: import("./errors.ts").UniplsOpenError;
    }>
  | Readonly<{
      type: "reconnector-failed";
      severity: "error";
      scope: Extract<UniplsDiagnosticScope, { type: "session" }>;
      occurredAt: number;
      context: "recovery";
      failurePoint: "setup" | "policy";
      cause: unknown;
      error: import("./errors.ts").UniplsDroppedError;
    }>;

/** Unipls が継続不能または継続可能な内部失敗を通知する診断情報です。 */
export type UniplsDiagnostic =
  | ReconnectorFailedDiagnostic
  | MessageDeserializationFailedDiagnostic
  | MessagePredicateFailedDiagnostic
  | StreamCallbackFailedDiagnostic
  | StreamMessageDroppedDiagnostic
  | ResourceCleanupFailedDiagnostic
  | DropDetectorFailedDiagnostic;

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
