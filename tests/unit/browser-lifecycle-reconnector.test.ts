import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BrowserLifecycleReconnector,
  BrowserLifecycleSource,
  ImmediateReconnector,
  type ReconnectionContext,
  type UniplsReconnector,
  type UniplsReconnectorActions,
} from "../../src/reconnectors.ts";

const sessions: AbortController[] = [];
function fixture(defaultReconnector: UniplsReconnector) {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const source = new BrowserLifecycleSource({ window, document, navigator: { onLine: true } });
  const session = new AbortController();
  sessions.push(session);
  const ctx = {
    origin: "initial",
    attempt: 1,
    signal: session.signal,
    cause: new Error("failure"),
  } as ReconnectionContext;
  const actions = { reconnect: vi.fn(), cancel: vi.fn(), exhaust: vi.fn() };
  const reconnector = new BrowserLifecycleReconnector({
    source,
    defaultReconnector,
    coalesceDelay: 10,
  });
  return { window, document, source, session, ctx, actions, reconnector };
}

describe("BrowserLifecycleReconnector defaultReconnector", () => {
  afterEach(() => {
    for (const session of sessions.splice(0)) {
      session.abort();
    }
    vi.useRealTimers();
  });

  it("ImmediateReconnector を使える", async () => {
    const f = fixture(new ImmediateReconnector());
    const cleanup = await f.reconnector.setup(f.actions, f.ctx);
    expect(f.actions.reconnect).toHaveBeenCalledOnce();
    cleanup?.();
  });

  it.each(["cancel", "exhaust"] as const)(
    "独自戦略の %s と元の context を尊重する",
    async (decision) => {
      const dispose = vi.fn();
      const cause = new Error("policy");
      const setup = vi.fn((actions: UniplsReconnectorActions) => {
        if (decision === "cancel") {
          actions.cancel();
        } else {
          actions.exhaust(cause);
        }
        actions.reconnect();
        return dispose;
      });
      const f = fixture({ setup });
      const cleanup = await f.reconnector.setup(f.actions, f.ctx);
      expect(setup.mock.calls[0]).toEqual([expect.any(Object), f.ctx]);
      if (decision === "cancel") {
        expect(f.actions.cancel).toHaveBeenCalledOnce();
      } else {
        expect(f.actions.exhaust).toHaveBeenCalledWith(cause);
      }
      expect(f.actions.reconnect).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      cleanup?.();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("復帰イベントで非同期戦略を無効にし、遅れて返ったdisposerを一度だけ実行する", async () => {
    vi.useFakeTimers();
    let delegated!: UniplsReconnectorActions;
    let resolve!: (disposer: () => void) => void;
    const pending = new Promise<() => void>((accept) => {
      resolve = accept;
    });
    const dispose = vi.fn();
    const f = fixture({
      setup(actions) {
        delegated = actions;
        return pending;
      },
    });
    const setup = f.reconnector.setup(f.actions, f.ctx);
    f.window.dispatchEvent(new Event("online"));
    delegated.reconnect();
    delegated.cancel();
    delegated.exhaust();
    expect(f.actions.reconnect).not.toHaveBeenCalled();
    expect(f.actions.cancel).not.toHaveBeenCalled();
    expect(f.actions.exhaust).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(f.actions.reconnect).toHaveBeenCalledOnce();
    resolve(dispose);
    const cleanup = await setup;
    expect(dispose).toHaveBeenCalledOnce();
    cleanup?.();
    expect(dispose).toHaveBeenCalledOnce();
    f.window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.actions.reconnect).toHaveBeenCalledOnce();
  });

  it("有効な非同期戦略のrejectをengineへ渡す", async () => {
    const cause = new Error("setup rejected");
    const f = fixture({ setup: () => Promise.reject(cause) });
    await expect(f.reconnector.setup(f.actions, f.ctx)).rejects.toBe(cause);
    f.window.dispatchEvent(new Event("online"));
    expect(f.actions.reconnect).not.toHaveBeenCalled();
  });

  it("休止で無効になった戦略の遅れたrejectを採用しない", async () => {
    vi.useFakeTimers();
    let reject!: (cause: unknown) => void;
    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const f = fixture({ setup: () => pending });
    const setup = f.reconnector.setup(f.actions, f.ctx);
    f.document.dispatchEvent(new Event("freeze"));
    reject(new Error("old failure"));
    const cleanup = await setup;
    f.document.dispatchEvent(new Event("resume"));
    await vi.advanceTimersByTimeAsync(10);
    expect(f.actions.reconnect).toHaveBeenCalledOnce();
    cleanup?.();
  });
});
