import type { ReconnectionContext, UniplsReconnectEvent } from "../reconnectors/reconnector.ts";
import { UniplsInvalidUsageError } from "../shared/errors.ts";
import type {
  ConnectionAttemptOrigin,
  ConnectionAttemptSnapshot,
  ConnectionAttemptStage,
  ConnectionId,
  SessionId,
  UniplsDrop,
  UniplsDroppedErrorOutcome,
  UniplsDropSource,
  UniplsLifecycleEvent,
  UniplsLifecycleSnapshot,
  UniplsOpenErrorOutcome,
} from "../shared/types.ts";

interface ActiveAttempt {
  readonly sequence: number;
  readonly cycle: number;
  readonly attempt: number;
  readonly origin: ConnectionAttemptOrigin;
  readonly connection: ConnectionId;
  readonly startedAt: number;
  readonly drop?: UniplsDrop;
  stage: ConnectionAttemptStage;
}

interface LogicalSession {
  readonly id: SessionId;
  readonly controller: AbortController;
  attempts: readonly ConnectionAttemptSnapshot[];
  activeAttempt?: ActiveAttempt;
  recoveryDrop?: UniplsDrop;
  cycle: number;
  nextSequence: number;
  nextAttempt: number;
  hasBeenReady: boolean;
  sessionSetupCompleted: boolean;
}

class IdGenerator {
  #nextSession = 1;
  #nextConnection = 1;

  session(): SessionId {
    const id = `session-${this.#nextSession}` as SessionId;

    this.#nextSession += 1;

    return id;
  }

  connection(): ConnectionId {
    const id = `connection-${this.#nextConnection}` as ConnectionId;

    this.#nextConnection += 1;

    return id;
  }
}

/** @internal 論理セッションと接続試行の状態遷移を一元管理します。 */
export class UniplsLifecycleCoordinator {
  readonly #ids = new IdGenerator();
  readonly #onTransition: (event: UniplsLifecycleEvent) => void;
  #snapshot: UniplsLifecycleSnapshot = Object.freeze({ phase: "closed", reason: "idle" });
  #session?: LogicalSession;

  constructor(onTransition: (event: UniplsLifecycleEvent) => void) {
    this.#onTransition = onTransition;
  }

  get snapshot(): UniplsLifecycleSnapshot {
    return this.#snapshot;
  }

  get hasActiveSession(): boolean {
    return this.#session !== undefined;
  }

  get hasBeenReady(): boolean {
    return this.#requireSession().hasBeenReady;
  }

  get session(): SessionId {
    return this.#requireSession().id;
  }

  get signal(): AbortSignal {
    return this.#requireSession().controller.signal;
  }

  get attempts(): readonly ConnectionAttemptSnapshot[] {
    return this.#requireSession().attempts;
  }

  get recoveryDrop(): UniplsDrop {
    const drop = this.#requireSession().recoveryDrop;

    if (!drop) {
      throw new Error("Recovery drop is missing");
    }

    return drop;
  }

  /** active な論理セッションへ operation を同期的に受け付けます。 */
  acceptOperation(): SessionId {
    if (!this.#session) {
      throw new UniplsInvalidUsageError(
        "通信操作は open intent が有効な論理セッション内でのみ開始できます。",
      );
    }

    return this.#session.id;
  }

  get isSessionBeginning(): boolean {
    return !this.#requireSession().sessionSetupCompleted;
  }

  isCurrentAttempt(connection: ConnectionId): boolean {
    return this.#session?.activeAttempt?.connection === connection;
  }

  beginSession(): ConnectionId {
    if (this.#session) {
      throw new Error("A logical session is already active");
    }

    this.#session = {
      id: this.#ids.session(),
      controller: new AbortController(),
      attempts: Object.freeze([]),
      cycle: 0,
      nextSequence: 1,
      nextAttempt: 1,
      hasBeenReady: false,
      sessionSetupCompleted: false,
    };

    return this.#beginAttempt("initial");
  }

  beginRecovery(drop: UniplsDrop): void {
    const session = this.#requireSession();

    session.cycle += 1;
    session.nextAttempt = 1;
    session.recoveryDrop = drop;
    session.activeAttempt = undefined;
    this.#transition({
      phase: "recovering",
      session: session.id,
      drop,
      nextAttempt: session.nextAttempt,
      attempts: session.attempts,
    });
  }

  beginNextAttempt(): ConnectionId {
    const session = this.#requireSession();

    return this.#beginAttempt(session.hasBeenReady ? "recovery" : "initial");
  }

  markProvisioning(connection: ConnectionId): void {
    const session = this.#requireSession();
    const attempt = this.#requireAttempt(connection);

    attempt.stage = "provisioning";
    this.#transition({ phase: "provisioning", ...this.#attemptingFields(session, attempt) });
  }

  markSessionSetupCompleted(): void {
    this.#requireSession().sessionSetupCompleted = true;
  }

  /** 失敗した接続試行を履歴へ確定し、次の policy 判断用 snapshot を返します。 */
  failAttempt(
    connection: ConnectionId,
    cause: unknown,
    failureDrop?: UniplsDrop,
  ): ReconnectionContext {
    const session = this.#requireSession();
    const attempt = this.#requireAttempt(connection);
    const recordDrop = attempt.origin === "recovery" ? attempt.drop : failureDrop;

    this.#appendAttempt(
      Object.freeze({
        sequence: attempt.sequence,
        cycle: attempt.cycle,
        attempt: attempt.attempt,
        origin: attempt.origin,
        connection: attempt.connection,
        startedAt: attempt.startedAt,
        endedAt: Date.now(),
        outcome: "failed" as const,
        stage: attempt.stage,
        cause,
        ...(recordDrop ? { drop: recordDrop } : {}),
      }),
    );
    session.activeAttempt = undefined;
    session.nextAttempt = attempt.attempt + 1;

    if (attempt.origin === "initial") {
      this.#transition({
        phase: "connecting",
        status: "waiting",
        session: session.id,
        origin: "initial",
        nextAttempt: session.nextAttempt,
        attempts: session.attempts,
      });
    } else {
      this.#transition({
        phase: "recovering",
        session: session.id,
        drop: this.recoveryDrop,
        nextAttempt: session.nextAttempt,
        attempts: session.attempts,
      });
    }

    const drop = attempt.origin === "recovery" ? this.recoveryDrop : failureDrop;

    return Object.freeze({
      session: session.id,
      origin: attempt.origin,
      stage: attempt.stage,
      attempt: attempt.attempt,
      cause,
      attempts: session.attempts,
      ...(drop ? { drop } : {}),
      signal: session.controller.signal,
    });
  }

  /** ready 接続を失った直後の最初の policy 判断用 snapshot を返します。 */
  buildRecoveryContext(cause: unknown): ReconnectionContext {
    const session = this.#requireSession();

    return Object.freeze({
      session: session.id,
      origin: "recovery",
      stage: "connecting",
      attempt: session.nextAttempt,
      cause,
      attempts: session.attempts,
      drop: this.recoveryDrop,
      signal: session.controller.signal,
    });
  }

  markReady(connection: ConnectionId): ConnectionAttemptOrigin {
    const session = this.#requireSession();
    const attempt = this.#requireAttempt(connection);

    this.#appendAttempt(
      Object.freeze({
        sequence: attempt.sequence,
        cycle: attempt.cycle,
        attempt: attempt.attempt,
        origin: attempt.origin,
        connection: attempt.connection,
        startedAt: attempt.startedAt,
        endedAt: Date.now(),
        outcome: "ready" as const,
      }),
    );
    const origin = attempt.origin;

    session.activeAttempt = undefined;
    session.hasBeenReady = true;
    session.recoveryDrop = undefined;
    this.#transition({
      phase: "open",
      session: session.id,
      connection,
      attempts: session.attempts,
    });

    return origin;
  }

  reconnectSucceeded(): UniplsReconnectEvent {
    const session = this.#requireSession();

    return Object.freeze({ session: session.id, outcome: "succeeded", attempts: session.attempts });
  }

  closeByUser(reason: unknown): void {
    const session = this.#session;

    if (!session) {
      return;
    }
    if (session.activeAttempt) {
      const attempt = session.activeAttempt;

      this.#appendAttempt(
        Object.freeze({
          sequence: attempt.sequence,
          cycle: attempt.cycle,
          attempt: attempt.attempt,
          origin: attempt.origin,
          connection: attempt.connection,
          startedAt: attempt.startedAt,
          endedAt: Date.now(),
          outcome: "aborted" as const,
          stage: attempt.stage,
          reason: "session-closed" as const,
        }),
      );
    }

    session.controller.abort(reason);
    const sessionId = session.id;
    const attempts = session.attempts;

    this.#session = undefined;
    this.#transition({ phase: "closed", reason: "user", session: sessionId, attempts });
  }

  terminateInitial(
    outcome: UniplsOpenErrorOutcome,
    error: unknown,
    cause: unknown,
    drop?: UniplsDrop,
  ): void {
    const session = this.#requireSession();

    session.controller.abort(error);
    const sessionId = session.id;
    const attempts = session.attempts;

    this.#session = undefined;
    this.#transition({
      phase: "closed",
      reason: "open-failed",
      session: sessionId,
      outcome,
      attempts,
      cause,
      ...(drop ? { drop } : {}),
    });
  }

  terminateRecovery(
    outcome: Exclude<UniplsDroppedErrorOutcome, "operation-failed">,
    error: unknown,
    cause?: unknown,
  ): void {
    const session = this.#requireSession();
    const drop = this.recoveryDrop;

    session.controller.abort(error);
    const sessionId = session.id;
    const attempts = session.attempts;

    this.#session = undefined;
    this.#transition({
      phase: "closed",
      reason: "dropped",
      session: sessionId,
      outcome,
      attempts,
      drop,
      ...(cause === undefined ? {} : { cause }),
    });
  }

  createDrop(
    connection: ConnectionId,
    report: {
      readonly source: UniplsDropSource;
      readonly close?: Readonly<{ code: number; reason: string; wasClean: boolean }>;
      readonly cause?: unknown;
    },
  ): UniplsDrop {
    const session = this.#requireSession();

    return Object.freeze({
      source: report.source,
      session: session.id,
      connection,
      detectedAt: Date.now(),
      ...(report.close ? { close: report.close } : {}),
      ...(report.cause === undefined ? {} : { cause: report.cause }),
    });
  }

  #beginAttempt(origin: ConnectionAttemptOrigin): ConnectionId {
    const session = this.#requireSession();
    const drop = origin === "recovery" ? session.recoveryDrop : undefined;

    if (origin === "recovery" && !drop) {
      throw new Error("Recovery drop is missing");
    }

    const connection = this.#ids.connection();
    const attempt: ActiveAttempt = {
      sequence: session.nextSequence,
      cycle: session.cycle,
      attempt: session.nextAttempt,
      origin,
      connection,
      startedAt: Date.now(),
      stage: "connecting",
      ...(drop ? { drop } : {}),
    };

    session.nextSequence += 1;
    session.activeAttempt = attempt;
    this.#transition({ phase: "connecting", ...this.#attemptingFields(session, attempt) });

    return connection;
  }

  #attemptingFields(session: LogicalSession, attempt: ActiveAttempt) {
    return {
      status: "attempting" as const,
      session: session.id,
      connection: attempt.connection,
      cycle: attempt.cycle,
      attempt: attempt.attempt,
      attempts: session.attempts,
      ...(attempt.origin === "initial"
        ? { origin: "initial" as const }
        : { origin: "recovery" as const, drop: attempt.drop as UniplsDrop }),
    };
  }

  #appendAttempt(attempt: ConnectionAttemptSnapshot): void {
    const session = this.#requireSession();

    session.attempts = Object.freeze([...session.attempts, attempt]);
  }

  #requireSession(): LogicalSession {
    if (!this.#session) {
      throw new Error("There is no active logical session");
    }

    return this.#session;
  }

  #requireAttempt(connection: ConnectionId): ActiveAttempt {
    const attempt = this.#requireSession().activeAttempt;

    if (!attempt || attempt.connection !== connection) {
      throw new Error("The connection attempt is no longer current");
    }

    return attempt;
  }

  #transition(snapshot: UniplsLifecycleSnapshot): void {
    const previous = this.#snapshot;
    const current = Object.freeze(snapshot);

    this.#snapshot = current;
    this.#onTransition(Object.freeze({ previous, current }));
  }
}
