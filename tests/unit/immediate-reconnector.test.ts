import { describe, expect, it, vi } from "vite-plus/test";

import { ImmediateReconnector } from "../../src/reconnectors.ts";
import type { ReconnectionContext, UniplsReconnectorActions } from "../../src/reconnectors.ts";

function setup(reconnector: ImmediateReconnector, attempt: number) {
  const actions: UniplsReconnectorActions = {
    reconnect: vi.fn(),
    cancel: vi.fn(),
    exhaust: vi.fn(),
  };
  const cause = new Error("connection failed");
  const context = { attempt, cause } as ReconnectionContext;

  reconnector.setup(actions, context);

  return { actions, cause };
}

describe("ImmediateReconnector", () => {
  it("既定では待たずに再接続する", () => {
    const { actions } = setup(new ImmediateReconnector(), 1);

    expect(actions.reconnect).toHaveBeenCalledOnce();
    expect(actions.exhaust).not.toHaveBeenCalled();
  });

  it("maxRetries回の再試行後に原因を渡して終了する", () => {
    const { actions: first } = setup(new ImmediateReconnector({ maxRetries: 2 }), 2);

    expect(first.reconnect).toHaveBeenCalledOnce();

    const { actions, cause } = setup(new ImmediateReconnector({ maxRetries: 2 }), 3);

    expect(actions.reconnect).not.toHaveBeenCalled();
    expect(actions.exhaust).toHaveBeenCalledWith(cause);
  });

  it("maxRetriesが0なら初回失敗後に再接続しない", () => {
    const { actions, cause } = setup(new ImmediateReconnector({ maxRetries: 0 }), 1);

    expect(actions.reconnect).not.toHaveBeenCalled();
    expect(actions.exhaust).toHaveBeenCalledWith(cause);
  });

  it("maxRetriesに負数や小数を受け付けない", () => {
    expect(() => new ImmediateReconnector({ maxRetries: -1 })).toThrow(RangeError);
    expect(() => new ImmediateReconnector({ maxRetries: 1.5 })).toThrow(RangeError);
  });
});
