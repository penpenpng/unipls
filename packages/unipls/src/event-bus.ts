type EventListener<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TEvents extends Record<string, any>,
  K extends keyof TEvents,
> = (args: TEvents[K]) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class EventBus<TEvents extends Record<string, any>> {
  #listeners: {
    [K in keyof TEvents]?: Map<EventListener<TEvents, K>, { once: boolean }>;
  } = {};

  protected getListeners<K extends keyof TEvents>(event: K) {
    return (this.#listeners[event] ??= new Map());
  }

  on<K extends keyof TEvents>(
    event: K,
    listener: EventListener<TEvents, K>,
    options?: { once?: boolean },
  ): () => void {
    const listeners = this.getListeners(event);
    listeners.set(listener, { once: options?.once ?? false });

    return () => {
      this.off(event, listener);
    };
  }

  /** @deprecated Use `on` with `once` */
  once<K extends keyof TEvents>(event: K, listener: EventListener<TEvents, K>): () => void {
    return this.on(event, listener, { once: true });
  }

  off<K extends keyof TEvents>(event: K, listener: EventListener<TEvents, K>): void {
    const listeners = this.getListeners(event);

    listeners.delete(listener);
  }

  emit<K extends keyof TEvents>(event: K, args: TEvents[K]): void {
    for (const [listener, options] of this.getListeners(event)) {
      if (options.once) {
        this.off(event, listener);
      }
      listener(args);
    }
  }

  spawnEventBusView(): EventBusView<TEvents> {
    return new EventBusView(this);
  }

  [Symbol.dispose] = () => {
    this.#listeners = {};
  };
  dispose = this[Symbol.dispose];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class EventBusView<TEvents extends Record<string, any>> {
  #events: EventBus<TEvents>;
  #cleanups: Set<() => void> = new Set();

  constructor(events: EventBus<TEvents>) {
    this.#events = events;
  }

  on<K extends keyof TEvents>(
    event: K,
    listener: EventListener<TEvents, K>,
    options?: { once?: boolean },
  ): () => void {
    const cleanup = this.#events.on(event, listener, options);
    this.#cleanups.add(cleanup);

    return () => {
      this.#cleanups.delete(cleanup);
      cleanup();
    };
  }

  /** @deprecated Use `on` with `once` */
  once<K extends keyof TEvents>(event: K, listener: EventListener<TEvents, K>): () => void {
    const cleanup = this.#events.on(event, listener, { once: true });
    this.#cleanups.add(cleanup);

    return () => {
      this.#cleanups.delete(cleanup);
      cleanup();
    };
  }

  [Symbol.dispose] = () => {
    for (const cleanup of this.#cleanups) {
      cleanup();
    }
    this.#cleanups.clear();
  };
  dispose = this[Symbol.dispose];
}
