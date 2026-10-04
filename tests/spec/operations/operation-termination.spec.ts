import { describe, expect, it, vi } from "vite-plus/test";

import { Unipls, UniplsTimeoutError, type UniplsLog } from "../../../src/index.ts";
import {
  ControlledProvisioner,
  ControlledWebSocketServer,
  flushMicrotasks,
  UniplsRaceScenario,
} from "../../support/index.ts";

describe("operation の timeout、abort、resource 解放", () => {
  /**
   * ```ts
   * const opening = client.open({
   *   setupConnection: () => waitForProvisioning(),
   * });
   * const response = client.next({ selector, timeout: 100 });
   * // ! provisioning が完了しないまま受付から100msが経過する
   * await response; // ready 待機中でも UniplsTimeoutError で reject する
   * ```
   */
  it("受付時から provisioning 待機を含めて一つの timeout を進める", async () => {
    vi.useFakeTimers();
    try {
      const transport = new ControlledWebSocketServer();
      const provisioner = new ControlledProvisioner();
      const client = new Unipls<string, string>({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
      });
      const opening = client.open(provisioner);
      const socket = transport.current;

      socket.emitOpen();
      const invocation = provisioner.invocations.take();
      const response = client.next({ selector: () => true, timeout: 100 });

      // ! ready にならなくても、受付からの wall-clock deadline で operation だけが終了します。
      await vi.advanceTimersByTimeAsync(100);
      await expect(response).rejects.toBeInstanceOf(UniplsTimeoutError);
      provisioner.succeed(invocation);
      await opening;
      const closing = client.close();

      socket.emitClose();
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ```ts
   * const beforeReady = client.cast({ query, timeout: 10 });
   * const afterSend = client.request({ query, selector, timeout: 10 });
   * const duringRecovery = client.request({ query, selector, retry: "wait", timeout: 10 });
   * // ! それぞれ ready 前、初回送信後、recovery 待機中に受付から10msが経過する
   * await beforeReady; // UniplsTimeoutError
   * await afterSend; // UniplsTimeoutError
   * await duringRecovery; // UniplsTimeoutError。次の接続で復活しない
   * ```
   */
  it("単発 operation の全待機段階を受付からの wall-clock timeout に含める", async () => {
    vi.useFakeTimers();
    try {
      const scenario = new UniplsRaceScenario();
      const opening = scenario.beginOpen();
      const first = scenario.transport.current;
      let castFactoryCalls = 0;
      const beforeReady = scenario.client.cast({
        query: () => {
          castFactoryCalls += 1;

          return "cast";
        },
        timeout: 10,
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(beforeReady).rejects.toBeInstanceOf(UniplsTimeoutError);
      expect(castFactoryCalls).toBe(0);
      first.emitOpen();
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await opening;
      const afterSend = scenario.client.request({
        query: "after-send",
        selector: () => true,
        timeout: 10,
      });

      await flushMicrotasks();
      expect(first.sent).toEqual(["after-send"]);
      await vi.advanceTimersByTimeAsync(10);
      await expect(afterSend).rejects.toBeInstanceOf(UniplsTimeoutError);
      const duringRecovery = scenario.client.request({
        query: "during-recovery",
        selector: () => true,
        retry: "wait",
        timeout: 10,
      });

      await flushMicrotasks();
      scenario.drop();
      const recovery = scenario.reconnector.invocations.take();

      await vi.advanceTimersByTimeAsync(10);
      await expect(duringRecovery).rejects.toBeInstanceOf(UniplsTimeoutError);
      recovery.reconnect();
      const replacement = scenario.transport.current;

      replacement.emitOpen();
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await scenario.waitForLifecycle(({ phase }) => phase === "open");
      replacement.emitMessage("late-response");
      await flushMicrotasks();
      expect(replacement.sent).toEqual([]);
      const closing = scenario.client.close();

      replacement.emitClose();
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ```ts
   * const controller = new AbortController();
   * controller.abort(cause);
   * const castResult = client.cast({ query, signal: controller.signal });
   * const nextResult = client.next({ selector, signal: controller.signal });
   * const requestResult = client.request({ query, selector, signal: controller.signal });
   * // 3件とも同期 throw せず、受付済み operation として cause そのもので reject する
   * ```
   */
  it("既に abort 済みの signal を単発 operation の非同期結果として扱う", async () => {
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const opening = client.open();
    const socket = transport.current;

    socket.emitOpen();
    await opening;
    const cause = new Error("already aborted");
    const controller = new AbortController();

    controller.abort(cause);
    const castResult = client.cast({ query: "cast", signal: controller.signal });
    const nextResult = client.next({ selector: () => true, signal: controller.signal });
    const requestResult = client.request({
      query: "request",
      selector: () => true,
      signal: controller.signal,
    });

    await expect(castResult).rejects.toBe(cause);
    await expect(nextResult).rejects.toBe(cause);
    await expect(requestResult).rejects.toBe(cause);
    expect(socket.sent).toEqual([]);
    const closing = client.close();

    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const continued = client.request({ query, selector: mayThrow });
   * const failed = client.request({ query, selector: mayThrow, predicateError: "fail" });
   * const independent = client.next({ selector: () => true });
   * // ! mayThrow が例外を投げる応答が届く
   * await failed; // 元の例外で reject する
   * await independent; // 同じ message の broadcast は止まらない
   * // ! 後続の一致応答が届く
   * await continued; // 既定 policy は後続応答の観測を続ける
   * ```
   */
  it("request の predicate failure を policy に従って隔離する", async () => {
    const transport = new ControlledWebSocketServer();
    const diagnostics: UniplsLog[] = [];
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      logSink: (log) => diagnostics.push(log),
    });
    const opening = client.open();
    const socket = transport.current;

    socket.emitOpen();
    await opening;
    const cause = new Error("request predicate failed");
    const mayThrow = (message: string) => {
      if (message === "bad") {
        throw cause;
      }

      return message === "good";
    };
    const continued = client.request({ query: "continued", selector: mayThrow });
    const failed = client.request({
      query: "failed",
      selector: mayThrow,
      predicateError: "fail",
    });
    const independent = client.next({ selector: (message) => message === "bad" });

    await flushMicrotasks();

    // ! 例外を起こす message も独立した operation には配送されます。
    socket.emitMessage("bad");
    await expect(failed).rejects.toBe(cause);
    await expect(independent).resolves.toBe("bad");
    socket.emitMessage("good");
    await expect(continued).resolves.toBe("good");
    await flushMicrotasks();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((log) => [log.event, log.level])).toEqual([
      ["operation/selection", "warning"],
      ["operation/selection", "error"],
    ]);
    const closing = client.close();

    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const completed = client.next({ selector, signal, timeout: 100 });
   * await completed; // 成功時に timer と message 登録を解放する
   * const aborted = client.next({ selector, signal: anotherSignal });
   * controller.abort(cause);
   * await aborted; // 中断時にも同じ資源を一度だけ解放する
   * ```
   */
  it("成功・中断・timeout の各終了経路で operation resource を一度だけ解放する", async () => {
    vi.useFakeTimers();
    try {
      const transport = new ControlledWebSocketServer();
      const client = new Unipls<string, string>({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
      });
      const opening = client.open();
      const socket = transport.current;

      socket.emitOpen();
      await opening;
      const signalAny = vi.spyOn(AbortSignal, "any");

      signalAny.mockClear();
      const completedController = new AbortController();
      const completedAdd = vi.spyOn(completedController.signal, "addEventListener");
      const completedRemove = vi.spyOn(completedController.signal, "removeEventListener");
      const completed = client.next({
        selector: (message) => message === "done",
        signal: completedController.signal,
        timeout: 100,
      });

      socket.emitMessage("done");
      await expect(completed).resolves.toBe("done");
      expect(completedAdd).not.toHaveBeenCalled();
      expect(completedRemove).not.toHaveBeenCalled();
      const abortedController = new AbortController();
      const abortedAdd = vi.spyOn(abortedController.signal, "addEventListener");
      const abortedRemove = vi.spyOn(abortedController.signal, "removeEventListener");
      const cause = new Error("aborted");
      const aborted = client.next({
        selector: () => true,
        signal: abortedController.signal,
        timeout: 100,
      });

      abortedController.abort(cause);
      await expect(aborted).rejects.toBe(cause);
      expect(abortedAdd).not.toHaveBeenCalled();
      expect(abortedRemove).not.toHaveBeenCalled();
      let selectorCalls = 0;
      const timedOut = client.next({
        selector: () => {
          selectorCalls += 1;

          return true;
        },
        timeout: 10,
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(timedOut).rejects.toBeInstanceOf(UniplsTimeoutError);
      socket.emitMessage("late");
      expect(selectorCalls).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(signalAny).toHaveBeenCalledTimes(3);
      const closing = client.close();

      socket.emitClose();
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});
