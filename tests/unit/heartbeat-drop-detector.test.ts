import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { HeartbeatDropDetector, type DropDetectorContext } from "../../src/drop-detectors.ts";
import type { DropDetectorIdentity } from "../../src/shared/types.ts";

describe("HeartbeatDropDetector", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("各timerの完了時にabort listenerを解除して未完了分だけを保持する", async () => {
    // 実際のAbortSignalへのlistener登録数を観測しながらheartbeatを繰り返します。
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const identity: DropDetectorIdentity = Object.freeze({ registrationIndex: 0 });
    let requestCount = 0;
    let running = Promise.resolve();
    const context: DropDetectorContext<string, string> = {
      detector: identity,
      signal: controller.signal,
      defer() {},
      drop() {},
      request: async () => {
        requestCount += 1;

        return "pong";
      },
      guard:
        (callback) =>
        (...args) => {
          void callback(...args);
        },
      run: (task) => {
        running = Promise.resolve(task(controller.signal));
      },
    };
    const detector = new HeartbeatDropDetector<string, string>({
      interval: 10,
      ping: "ping",
      pong: (message) => message === "pong",
    });

    detector.setup(context);

    // timerが完了するたびに直前のlistenerを外し、次の待機用の1件だけを残します。
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(10);
    }

    const abortAdds = addListener.mock.calls.filter(([type]) => type === "abort").length;
    const abortRemoves = removeListener.mock.calls.filter(([type]) => type === "abort").length;

    expect(requestCount).toBe(5);
    expect(abortAdds - abortRemoves).toBe(1);

    // 接続終了時には最後の待機listenerも解除し、background taskを正常終了します。
    controller.abort(new Error("connection ended"));
    await running;
    const finalAbortRemoves = removeListener.mock.calls.filter(([type]) => type === "abort").length;

    expect(finalAbortRemoves).toBe(abortAdds);
  });

  it("接続終了以外のrequest failureをrunの監督境界へ渡す", async () => {
    // heartbeat requestの予期しない失敗を観測できるcontextを作ります。
    vi.useFakeTimers();
    const controller = new AbortController();
    const cause = new Error("heartbeat request failed");
    let dropCount = 0;
    let running = Promise.resolve();
    const context: DropDetectorContext<string, string> = {
      detector: Object.freeze({ registrationIndex: 0 }),
      signal: controller.signal,
      defer() {},
      drop() {
        dropCount += 1;
      },
      request: () => Promise.reject(cause),
      guard:
        (callback) =>
        (...args) => {
          void callback(...args);
        },
      run: (task) => {
        running = Promise.resolve(task(controller.signal));
      },
    };
    const detector = new HeartbeatDropDetector<string, string>({
      interval: 10,
      ping: "ping",
      pong: (message) => message === "pong",
    });

    detector.setup(context);

    // ! timer完了後のrequestが失敗すると、timeoutとしてdropせずtaskをrejectします。
    const failure = expect(running).rejects.toBe(cause);

    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(dropCount).toBe(0);
  });
});
