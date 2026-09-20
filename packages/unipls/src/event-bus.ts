type EventListener<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 任意の event map を型引数として受け取るために必要です。
  TEvents extends Record<string, any>,
  K extends keyof TEvents,
> = (args: TEvents[K]) => void;

/** @internal 型付き event の登録、解除、同期通知を管理します。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 任意の event map を型引数として受け取るために必要です。
export class EventBus<TEvents extends Record<string, any>> {
  #listeners: {
    [K in keyof TEvents]?: Map<EventListener<TEvents, K>, { once: boolean }>;
  } = {};

  protected getListeners<K extends keyof TEvents>(event: K) {
    return (this.#listeners[event] ??= new Map());
  }

  /** event listener を登録し、解除関数を返します。 */
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

  /** 登録済みの event listener を解除します。 */
  off<K extends keyof TEvents>(event: K, listener: EventListener<TEvents, K>): void {
    const listeners = this.getListeners(event);

    listeners.delete(listener);
  }

  /** 指定した event の listener を登録順に同期実行します。 */
  emit<K extends keyof TEvents>(event: K, args: TEvents[K]): void {
    for (const [listener, options] of this.getListeners(event)) {
      if (options.once) {
        this.off(event, listener);
      }
      listener(args);
    }
  }

  /** listener の例外を相互に隔離し、次の microtask で event を通知します。 */
  emitIsolated<K extends keyof TEvents>(event: K, args: TEvents[K]): void {
    const listeners = [...this.getListeners(event)];
    queueMicrotask(() => {
      for (const [listener, options] of listeners) {
        if (options.once) this.off(event, listener);
        try {
          listener(args);
        } catch {
          // 診断 listener の失敗は library の処理へ逆流させません。
        }
      }
    });
  }

  /** この view から登録した listener をまとめて解放できる view を作成します。 */
  spawnEventBusView(): EventBusView<TEvents> {
    return new EventBusView(this);
  }

  /** すべての listener を解除します。 */
  [Symbol.dispose] = () => {
    this.#listeners = {};
  };
  dispose = this[Symbol.dispose];
}

/** @internal 登録した listener を所有する event bus の view です。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 任意の event map を型引数として受け取るために必要です。
class EventBusView<TEvents extends Record<string, any>> {
  #events: EventBus<TEvents>;
  #cleanups: Set<() => void> = new Set();

  constructor(events: EventBus<TEvents>) {
    this.#events = events;
  }

  /** event listener を登録し、この view から解除できるようにします。 */
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

  /** この view から登録したすべての listener を解除します。 */
  [Symbol.dispose] = () => {
    for (const cleanup of this.#cleanups) {
      cleanup();
    }
    this.#cleanups.clear();
  };
  dispose = this[Symbol.dispose];
}
