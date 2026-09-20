import type {
  ReconnectionContext,
  UniplsReconnector,
  UniplsReconnectorActions,
} from "../../src/index.ts";
import { ControlledHook, type ControlledInvocation } from "./controlled-hook.ts";
import { ObservationQueue } from "./observation-queue.ts";

export class ControlledProvisioner<TContext = unknown> {
  readonly #hook = new ControlledHook<TContext>();
  readonly invocations = this.#hook.invocations;
  readonly setupConnection = this.#hook.invoke;

  succeed(invocation: ControlledInvocation<TContext>): void {
    invocation.resolve(undefined);
  }

  fail(invocation: ControlledInvocation<TContext>, cause: unknown): void {
    invocation.reject(cause);
  }
}

export class ControlledReconnectorInvocation {
  readonly context: ReconnectionContext;
  cleanupCount = 0;
  action: "pending" | "reconnect" | "cancel" | "exhaust" = "pending";
  readonly #actions: UniplsReconnectorActions;

  constructor(actions: UniplsReconnectorActions, context: ReconnectionContext) {
    this.#actions = actions;
    this.context = context;
  }

  reconnect(): void {
    this.#act("reconnect", this.#actions.reconnect);
  }

  /** settle 済み action を再送し、client 側の冪等性を検証します。 */
  replayReconnect(): void {
    this.#actions.reconnect();
  }

  cancel(): void {
    this.#act("cancel", this.#actions.cancel);
  }

  exhaust(cause?: unknown): void {
    this.#act("exhaust", () => this.#actions.exhaust(cause));
  }

  cleanup = (): void => {
    this.cleanupCount += 1;
  };

  #act(action: Exclude<ControlledReconnectorInvocation["action"], "pending">, run: () => void) {
    if (this.action !== "pending") {
      throw new Error(`Reconnector action is already ${this.action}`);
    }
    this.action = action;
    run();
  }
}

export class ControlledReconnector implements UniplsReconnector {
  readonly invocations = new ObservationQueue<ControlledReconnectorInvocation>();
  #nextSetupFailure: unknown;
  #hasSetupFailure = false;
  #nextSetupRejection: unknown;
  #hasSetupRejection = false;

  failNextSetup(cause: unknown): void {
    this.#nextSetupFailure = cause;
    this.#hasSetupFailure = true;
  }

  rejectNextSetup(cause: unknown): void {
    this.#nextSetupRejection = cause;
    this.#hasSetupRejection = true;
  }

  setup(
    actions: UniplsReconnectorActions,
    context: ReconnectionContext,
  ): (() => void) | PromiseLike<void | (() => void)> {
    if (this.#hasSetupFailure) {
      const cause = this.#nextSetupFailure;
      this.#nextSetupFailure = undefined;
      this.#hasSetupFailure = false;
      throw cause;
    }
    if (this.#hasSetupRejection) {
      const cause = this.#nextSetupRejection;
      this.#nextSetupRejection = undefined;
      this.#hasSetupRejection = false;
      return Promise.reject(cause);
    }

    const invocation = new ControlledReconnectorInvocation(actions, context);
    this.invocations.push(invocation);
    return invocation.cleanup;
  }
}

export class ControlledDropDetectorInvocation<TContext> {
  readonly context: TContext;
  cleanupCount = 0;

  constructor(context: TContext) {
    this.context = context;
  }

  drop(): void {
    const context = this.context as { drop(): void };
    context.drop();
  }

  cleanup = (): void => {
    this.cleanupCount += 1;
  };
}

export class ControlledDropDetector<TContext = unknown> {
  readonly invocations = new ObservationQueue<ControlledDropDetectorInvocation<TContext>>();
  #nextSetupFailure: unknown;
  #hasSetupFailure = false;

  constructor(readonly name?: string) {}

  failNextSetup(cause: unknown): void {
    this.#nextSetupFailure = cause;
    this.#hasSetupFailure = true;
  }

  setup = (context: TContext): (() => void) => {
    if (this.#hasSetupFailure) {
      const cause = this.#nextSetupFailure;
      this.#nextSetupFailure = undefined;
      this.#hasSetupFailure = false;
      throw cause;
    }

    const invocation = new ControlledDropDetectorInvocation(context);
    this.invocations.push(invocation);
    return invocation.cleanup;
  };
}
