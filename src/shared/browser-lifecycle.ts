/** browser lifecycle のイベント名です。 */
export type BrowserLifecycleTrigger =
  | "visibility-hidden"
  | "visibility-visible"
  | "pagehide"
  | "pageshow"
  | "freeze"
  | "resume"
  | "offline"
  | "online";

/** DOM 全体に依存せず、イベント対象を差し替えるための公開形です。 */
export interface BrowserLifecycleEventTarget {
  addEventListener(type: string, callback: (event: { readonly type: string }) => void): void;
  removeEventListener(type: string, callback: (event: { readonly type: string }) => void): void;
}

export interface BrowserLifecycleEnvironment {
  readonly window: BrowserLifecycleEventTarget;
  readonly document: BrowserLifecycleEventTarget & { readonly visibilityState: string };
  readonly navigator: { readonly onLine: boolean };
}

/** source の現在の状態とイベントの世代です。 */
export interface BrowserLifecycleSnapshot {
  readonly revision: number;
  readonly suspended: boolean;
  readonly hidden: boolean;
  readonly offline: boolean;
}

export interface BrowserLifecycleEvent extends BrowserLifecycleSnapshot {
  readonly trigger: BrowserLifecycleTrigger;
  readonly recovery: boolean;
}

/**
 * 一つの client で detector と reconnector が共有する browser event source です。
 * 最初の購読時にブラウザーへアクセスし、最後の所有者が終了すると listener を解除します。
 */
export class BrowserLifecycleSource {
  #environment?: BrowserLifecycleEnvironment;
  #listeners = new Set<(event: BrowserLifecycleEvent) => void>();
  #owners = 0;
  #sessions = new WeakSet<AbortSignal>();
  #revision = 0;
  #frozen = false;
  #pageHidden = false;

  constructor(environment?: BrowserLifecycleEnvironment) {
    this.#environment = environment;
  }

  #getEnvironment(): BrowserLifecycleEnvironment {
    return (this.#environment ??= { window, document, navigator });
  }

  get snapshot(): BrowserLifecycleSnapshot {
    const env = this.#getEnvironment();
    return Object.freeze({
      revision: this.#revision,
      suspended: this.#frozen || this.#pageHidden,
      hidden: env.document.visibilityState === "hidden",
      offline: env.navigator.onLine === false,
    });
  }

  /** 接続試行の間も観測を継続し、session 終了時に所有権を解放します。 */
  retainSession(signal: AbortSignal): void {
    if (signal.aborted || this.#sessions.has(signal)) {
      return;
    }
    this.#sessions.add(signal);
    const release = this.#retain();
    signal.addEventListener(
      "abort",
      () => {
        this.#sessions.delete(signal);
        release();
      },
      { once: true },
    );
  }

  subscribe(listener: (event: BrowserLifecycleEvent) => void): () => void {
    const release = this.#retain();
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.#listeners.delete(listener);
      release();
    };
  }

  #retain(): () => void {
    const env = this.#getEnvironment();
    if (this.#owners++ === 0) {
      for (const type of ["pagehide", "pageshow", "offline", "online"]) {
        env.window.addEventListener(type, this.#handle);
      }
      for (const type of ["visibilitychange", "freeze", "resume"]) {
        env.document.addEventListener(type, this.#handle);
      }
    }
    return () => {
      if (--this.#owners !== 0) {
        return;
      }
      this.#frozen = false;
      this.#pageHidden = false;
      for (const type of ["pagehide", "pageshow", "offline", "online"]) {
        env.window.removeEventListener(type, this.#handle);
      }
      for (const type of ["visibilitychange", "freeze", "resume"]) {
        env.document.removeEventListener(type, this.#handle);
      }
    };
  }

  #handle = (event: { readonly type: string }): void => {
    let trigger: BrowserLifecycleTrigger;
    if (event.type === "visibilitychange") {
      trigger = this.snapshot.hidden ? "visibility-hidden" : "visibility-visible";
    } else {
      trigger = event.type as BrowserLifecycleTrigger;
    }
    if (trigger === "freeze") {
      this.#frozen = true;
    }
    if (trigger === "pagehide") {
      this.#pageHidden = true;
    }
    if (trigger === "resume" || trigger === "pageshow") {
      this.#frozen = false;
      this.#pageHidden = false;
    }
    this.#revision++;
    const recovery =
      trigger === "visibility-visible" ||
      trigger === "pageshow" ||
      trigger === "resume" ||
      trigger === "online";
    const notification = Object.freeze({ ...this.snapshot, trigger, recovery });
    // 通知中に購読が切り替わっても、新しい購読者に同じイベントを再配信しません。
    const listeners = [...this.#listeners];
    for (const listener of listeners) {
      listener(notification);
    }
  };
}
