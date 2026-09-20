import type {
  ConnectionAttemptOrigin,
  ConnectionAttemptSnapshot,
  ConnectionAttemptStage,
  ConnectionId,
  SessionId,
  UniplsDrop,
  UniplsLifecycleEvent,
  UniplsLifecycleSnapshot,
} from "./types.ts";
import type {
  ReconnectionAttempt,
  ReconnectionContext,
  UniplsReconnectEvent,
} from "./reconnector/reconnector.ts";

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
  lastReconnectError?: unknown;
  readonly reconnectAttempts: ReconnectionAttempt[];
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

export class UniplsLifecycleCoordinator {
  readonly #ids = new IdGenerator();
  readonly #allReconnectAttempts: ReconnectionAttempt[] = [];
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
      reconnectAttempts: [],
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

  beginRecoveryAttempt(): ConnectionId {
    return this.#beginAttempt("recovery");
  }

  markProvisioning(connection: ConnectionId): void {
    const session = this.#requireSession();
    const attempt = this.#requireAttempt(connection);
    attempt.stage = "provisioning";
    this.#transition({
      phase: "provisioning",
      ...this.#attemptingFields(session, attempt),
    });
  }

  markSessionSetupCompleted(): void {
    this.#requireSession().sessionSetupCompleted = true;
  }

  buildReconnectionContext(): ReconnectionContext {
    const session = this.#requireSession();
    return {
      session: session.id,
      lastAttemptedAt: session.reconnectAttempts.at(-1)?.attemptedAt,
      error: session.lastReconnectError,
      sessionAttempts: session.reconnectAttempts,
      allAttempts: this.#allReconnectAttempts,
      signal: session.controller.signal,
    };
  }

  recordReconnectAttempt(): void {
    const session = this.#requireSession();
    const attempt: ReconnectionAttempt = {
      session: session.id,
      attemptedAt: Date.now(),
      error: session.lastReconnectError,
    };
    session.reconnectAttempts.push(attempt);
    this.#allReconnectAttempts.push(attempt);
  }

  reconnectSucceeded(): UniplsReconnectEvent {
    const session = this.#requireSession();
    session.lastReconnectError = undefined;
    return Object.freeze({
      session: session.id,
      sessionAttempts: Object.freeze([...session.reconnectAttempts]),
    });
  }

  reconnectFailed(cause: unknown): void {
    this.#requireSession().lastReconnectError = cause;
  }

  markReady(connection: ConnectionId): void {
    const session = this.#requireSession();
    const attempt = this.#requireAttempt(connection);
    const record = Object.freeze({
      sequence: attempt.sequence,
      cycle: attempt.cycle,
      attempt: attempt.attempt,
      origin: attempt.origin,
      connection: attempt.connection,
      startedAt: attempt.startedAt,
      endedAt: Date.now(),
      outcome: "ready" as const,
    });
    this.#appendAttempt(record);
    session.activeAttempt = undefined;
    session.hasBeenReady = true;
    session.recoveryDrop = undefined;
    this.#transition({
      phase: "open",
      session: session.id,
      connection,
      attempts: session.attempts,
    });
  }

  failInitialAttempt(
    connection: ConnectionId,
    cause: unknown,
  ): readonly ConnectionAttemptSnapshot[] {
    const session = this.#requireSession();
    const attempt = this.#requireAttempt(connection);
    this.#appendFailedAttempt(attempt, cause);
    session.activeAttempt = undefined;
    session.controller.abort(cause);
    const attempts = session.attempts;
    const sessionId = session.id;
    this.#session = undefined;
    this.#transition({
      phase: "closed",
      reason: "open-failed",
      session: sessionId,
      outcome: "attempt-failed",
      attempts,
      cause,
    });
    return attempts;
  }

  failRecoveryAttempt(connection: ConnectionId, cause: unknown): void {
    const session = this.#requireSession();
    const attempt = this.#requireAttempt(connection);
    this.#appendFailedAttempt(attempt, cause);
    session.activeAttempt = undefined;
    session.nextAttempt = attempt.attempt + 1;
    const drop = session.recoveryDrop;
    if (!drop) {
      throw new Error("Recovery drop is missing");
    }
    this.#transition({
      phase: "recovering",
      session: session.id,
      drop,
      nextAttempt: session.nextAttempt,
      attempts: session.attempts,
    });
  }

  closeByUser(): void {
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
    session.controller.abort(new Error("Session closed"));
    const sessionId = session.id;
    const attempts = session.attempts;
    this.#session = undefined;
    this.#transition({
      phase: "closed",
      reason: "user",
      session: sessionId,
      attempts,
    });
  }

  createPeerDrop(code?: number): UniplsDrop {
    const session = this.#requireSession();
    const connection = this.#currentConnection();
    const close =
      code === undefined ? undefined : Object.freeze({ code, reason: "", wasClean: code === 1000 });
    return Object.freeze({
      source: Object.freeze({ type: "peer-close" as const }),
      session: session.id,
      connection,
      detectedAt: Date.now(),
      ...(close ? { close } : {}),
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
    this.#transition({
      phase: "connecting",
      ...this.#attemptingFields(session, attempt),
    });
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

  #appendFailedAttempt(attempt: ActiveAttempt, cause: unknown): void {
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
        ...(attempt.drop ? { drop: attempt.drop } : {}),
      }),
    );
  }

  #appendAttempt(attempt: ConnectionAttemptSnapshot): void {
    const session = this.#requireSession();
    session.attempts = Object.freeze([...session.attempts, attempt]);
  }

  #currentConnection(): ConnectionId {
    const snapshot = this.#snapshot;
    if (snapshot.phase === "open" || snapshot.phase === "provisioning") {
      return snapshot.connection;
    }
    if (snapshot.phase === "connecting" && snapshot.status === "attempting") {
      return snapshot.connection;
    }
    throw new Error("There is no current connection");
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
