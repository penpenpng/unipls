import type { UniplsMessageFactory } from "../unipls.interface.ts";

export class QuerySession<TInput, TOutput> {
  #currentQuery: UniplsMessageFactory<TInput>;
  #currentSelector: (data: TOutput) => boolean;
  #sent = false;
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

  get sent(): boolean {
    return this.#sent;
  }

  get currentQuery(): UniplsMessageFactory<TInput> {
    return this.#currentQuery;
  }

  get currentSelector(): (data: TOutput) => boolean {
    return this.#currentSelector;
  }

  send(
    query: UniplsMessageFactory<TInput>,
    params: { selector: (data: TOutput) => boolean; isDone: () => boolean },
  ): void {
    if (params.isDone()) {
      return;
    }

    let payload: TInput;
    try {
      payload = this.#evaluate(query);
    } catch (error) {
      this.#onError(error);
      return;
    }
    if (params.isDone()) {
      return;
    }

    this.#sendPayload(payload)
      .then(() => {
        this.#sent = true;
        this.#currentQuery = query;
        this.#currentSelector = params.selector;
      })
      .catch((error) => {
        this.#onError(error);
      });
  }

  resetForReconnect(): void {
    this.#sent = false;
  }
}
