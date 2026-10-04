import type { ConnectionId, OperationId, OperationType, SessionId } from "../shared/types.ts";

export type MessageDeliveryMode =
  | Readonly<{ type: "ready" }>
  | Readonly<{ type: "transport"; connection: ConnectionId }>;

interface MessageRegistration<T> {
  readonly operation: OperationId;
  readonly session: SessionId;
  readonly operationType: OperationType;
  readonly mode?: MessageDeliveryMode;
  readonly receive?: (message: T) => void;
}

/** @internal operation の登録と受信メッセージの候補選択を管理します。 */
export class MessageDispatcher<T> {
  #nextOperation = 1;
  readonly #registrations = new Map<OperationId, MessageRegistration<T>>();

  register(params: {
    session: SessionId;
    operationType: OperationType;
    mode?: MessageDeliveryMode;
    receive?: (message: T) => void;
  }): Readonly<{ operation: OperationId; unregister: () => void }> {
    const operation = `operation-${this.#nextOperation++}` as OperationId;

    this.#registrations.set(operation, { operation, ...params });
    let registered = true;

    return Object.freeze({
      operation,
      unregister: () => {
        if (!registered) {
          return;
        }

        registered = false;

        this.#registrations.delete(operation);
      },
    });
  }

  dispatchReady(session: SessionId, message: T): void {
    this.#dispatch(message, (registration) => {
      return registration.session === session && registration.mode?.type === "ready";
    });
  }

  dispatchTransport(session: SessionId, connection: ConnectionId, message: T): void {
    this.#dispatch(message, (registration) => {
      return (
        registration.session === session &&
        registration.mode?.type === "transport" &&
        registration.mode.connection === connection
      );
    });
  }

  #dispatch(message: T, isCandidate: (registration: MessageRegistration<T>) => boolean): void {
    for (const registration of Array.from(this.#registrations.values())) {
      if (!this.#registrations.has(registration.operation) || !isCandidate(registration)) {
        continue;
      }

      registration.receive?.(message);
    }
  }
}
