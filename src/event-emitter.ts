type EventListener<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TEvents extends Record<string, any[]>,
  K extends keyof TEvents,
> = (args: TEvents[K]) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class EventEmitter<TEvents extends Record<string, any[]>> {
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
}
