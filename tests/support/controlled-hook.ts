import { ObservationQueue } from "./observation-queue.ts";

export type GateState = "pending" | "resolved" | "rejected";

export class ControlledInvocation<TContext, TResult = void> {
  readonly context: TContext;
  readonly promise: Promise<TResult>;
  #state: GateState = "pending";
  #resolve!: (value: TResult | PromiseLike<TResult>) => void;
  #reject!: (cause: unknown) => void;

  get state(): GateState {
    return this.#state;
  }

  constructor(context: TContext) {
    this.context = context;
    this.promise = new Promise<TResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });

    void this.promise.catch(() => {});
  }

  resolve(value: TResult): void {
    this.#settle("resolved", () => this.#resolve(value));
  }

  reject(cause: unknown): void {
    this.#settle("rejected", () => this.#reject(cause));
  }

  #settle(state: Exclude<GateState, "pending">, settle: () => void): void {
    if (this.#state !== "pending") {
      throw new Error(`Invocation is already ${this.#state}`);
    }

    this.#state = state;

    settle();
  }
}

export class ControlledHook<TContext, TResult = void> {
  readonly invocations = new ObservationQueue<ControlledInvocation<TContext, TResult>>();

  invoke = (context: TContext): Promise<TResult> => {
    const invocation = new ControlledInvocation<TContext, TResult>(context);

    this.invocations.push(invocation);

    return invocation.promise;
  };
}
