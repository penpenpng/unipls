import type { UniplsMessageFactory } from "../client/unipls.interface.ts";

export class QuerySession<TInput, TOutput> {
  #currentQuery: UniplsMessageFactory<TInput>;
  #currentSelector: (data: TOutput) => boolean;
  #attempted = false;
  #observing = false;
  #paused = false;
  #sendSequence = 0;
  #evaluate: (query: UniplsMessageFactory<TInput>) => TInput;
  #sendPayload: (payload: TInput) => Promise<void>;
  #onError: (error: unknown) => void;

  constructor(params: {
    query: UniplsMessageFactory<TInput>;
    selector: (data: TOutput) => boolean;
    evaluate: (query: UniplsMessageFactory<TInput>) => TInput;
    sendPayload: (payload: TInput) => Promise<void>;
    onError: (error: unknown) => void;
  }) {
    this.#currentQuery = params.query;
    this.#currentSelector = params.selector;
    this.#evaluate = params.evaluate;
    this.#sendPayload = params.sendPayload;
    this.#onError = params.onError;
  }

  get observing(): boolean {
    return this.#observing;
  }

  get attempted(): boolean {
    return this.#attempted;
  }

  get currentQuery(): UniplsMessageFactory<TInput> {
    return this.#currentQuery;
  }

  get currentSelector(): (data: TOutput) => boolean {
    return this.#currentSelector;
  }

  send(
    query: UniplsMessageFactory<TInput>,
    params: {
      selector: (data: TOutput) => boolean;
      isDone: () => boolean;
      canSend: () => boolean;
    },
  ): Promise<void> {
    if (params.isDone()) {
      return Promise.resolve();
    }

    let payload: TInput;

    try {
      payload = this.#evaluate(query);
    } catch (error) {
      this.#onError(error);

      return Promise.resolve();
    }

    if (params.isDone() || !params.canSend()) {
      return Promise.resolve();
    }

    this.#attempted = true;
    this.#observing = false;
    this.#paused = false;
    this.#currentQuery = query;
    this.#currentSelector = params.selector;
    const sequence = ++this.#sendSequence;

    return this.#sendPayload(payload)
      .then(() => {
        if (sequence === this.#sendSequence && !this.#paused && !params.isDone()) {
          this.#observing = true;
        }
      })
      .catch((error) => {
        if (sequence === this.#sendSequence && !params.isDone()) {
          this.#onError(error);
        }
      });
  }

  pauseForReconnect(): void {
    this.#paused = true;
    this.#observing = false;
  }

  resumeWithoutResend(): void {
    this.#paused = false;
    this.#observing = true;
  }
}
