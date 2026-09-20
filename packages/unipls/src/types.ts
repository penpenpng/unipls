/** WebSocket によって送受信することができるデータを表します。 */
export type WebSocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

declare const sessionIdBrand: unique symbol;
declare const connectionIdBrand: unique symbol;
declare const operationIdBrand: unique symbol;

/** `open()` から terminal outcome まで維持される論理セッションの識別子です。 */
export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };

/** 一回の transport 接続試行の識別子です。 */
export type ConnectionId = string & { readonly [connectionIdBrand]: "ConnectionId" };

/** 一回の通信操作の識別子です。 */
export type OperationId = string & { readonly [operationIdBrand]: "OperationId" };

export type WebSocketConstructor = new (url: string) => WebSocket;

export type UniplsConnectionState = "connecting" | "provisioning" | "open" | "closed" | "dropped";

export type UniplsConnectionIntent = "open" | "close";

export type ConnectionAttemptOrigin = "initial" | "recovery";
export type ConnectionAttemptStage = "connecting" | "provisioning";

export interface DropDetectorIdentity {
  readonly registrationIndex: number;
  readonly name?: string;
}

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

export type UniplsDropSource =
  | Readonly<{ type: "peer-close" }>
  | Readonly<{ type: "transport-error" }>
  | Readonly<{ type: "timeout" }>
  | Readonly<{ type: "detector"; detector: DropDetectorIdentity }>
  | Readonly<{ type: "manual-drop" }>;

export interface UniplsDrop {
  readonly source: UniplsDropSource;
  readonly session: SessionId;
  readonly connection: ConnectionId;
  readonly detectedAt: number;
  readonly close?: Readonly<{
    code: number;
    reason: string;
    wasClean: boolean;
  }>;
  readonly cause?: unknown;
}

export type UniplsOpenErrorOutcome =
  | "attempt-failed"
  | "attempts-cancelled"
  | "attempts-exhausted"
  | "reconnector-failed";

export type UniplsDroppedErrorOutcome =
  | "operation-failed"
  | "recovery-cancelled"
  | "recovery-exhausted"
  | "reconnector-failed";

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

export interface UniplsLifecycleEvent {
  readonly previous: UniplsLifecycleSnapshot;
  readonly current: UniplsLifecycleSnapshot;
}
