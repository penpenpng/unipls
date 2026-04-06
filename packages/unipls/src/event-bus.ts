type EventListener<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TEvents extends Record<string, any>,
  K extends keyof TEvents,
> = (args: TEvents[K]) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class EventBus<TEvents extends Record<string, any>> {
  #listeners: {
    [K in keyof TEvents]?: Set<EventListener<TEvents, K>>;
  } = {};

  protected getListeners<K extends keyof TEvents>(event: K) {
    return (this.#listeners[event] ??= new Set());
  }

  on<K extends keyof TEvents>(
    event: K,
    listener: EventListener<TEvents, K>,
  ): () => void {
    const listeners = this.getListeners(event);

    listeners.add(listener);

    return () => {
      this.off(event, listener);
    };
  }

  once<K extends keyof TEvents>(
    event: K,
    listener: EventListener<TEvents, K>,
  ): () => void {
    const off = this.on(event, (args: TEvents[K]) => {
      off();
      listener(args);
    });

    return off;
  }

  off<K extends keyof TEvents>(
    event: K,
    listener: EventListener<TEvents, K>,
  ): void {
    const listeners = this.getListeners(event);

    listeners.delete(listener);
  }

  emit<K extends keyof TEvents>(event: K, args: TEvents[K]): void {
    for (const listener of this.getListeners(event)) {
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
  ): () => void {
    const cleanup = this.#events.on(event, listener);
    this.#cleanups.add(cleanup);

    return () => {
      this.#cleanups.delete(cleanup);
      cleanup();
    };
  }

  once<K extends keyof TEvents>(
    event: K,
    listener: EventListener<TEvents, K>,
  ): () => void {
    const cleanup = this.#events.once(event, listener);
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
