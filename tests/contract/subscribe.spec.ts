import { describe, expect, it, vi } from "vite-plus/test";

import { Unipls, UniplsDroppedError, UniplsTimeoutError } from "../../src/index.ts";
import { closeClient, ControlledWebSocketServer } from "../support/index.ts";
import { flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

describe("Unipls.subscribe の主要シナリオ", () => {
  /**
   * ```ts
   * const subscription = client.subscribe({
   *   query: "watch",
   *   selector: isItem,
   *   terminator: isEnd,
   *   next: consumeItem,
   * });
   * // ! ready前のitemは無視し、watch送信後のitemだけを配送する
   * await subscription.closed; // 終端messageでterminatedになる
   * ```
   */
  it("query送信後の一致messageを継続配送し、terminatorで購読を終了する", async () => {
    // provisioningを止め、subscribeの送信前後に届くmessageを区別します。
    const transport = new ControlledWebSocketServer();
    let finishProvisioning!: () => void;
    const provisioningGate = new Promise<void>((resolve) => {
      finishProvisioning = resolve;
    });
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const messages: string[] = [];
    const opening = client.open({ setupConnection: () => provisioningGate });

    // ! WebSocketが接続し、未完了のprovisioningが開始されます。
    const socket = transport.current;
    socket.emitOpen();
    const subscription = client.subscribe({
      query: "watch",
      selector: (message) => message.startsWith("item:"),
      terminator: (message) => message === "item:end",
      next: (message) => messages.push(message),
    });

    // ! query送信前に届いたmessageは購読へ配送しません。
    socket.emitMessage("item:before");
    expect(messages).toEqual([]);
    expect(socket.sent).toEqual([]);

    // readyへ進むとqueryを一度送信し、その後のmessageを観測します。
    finishProvisioning();
    await opening;
    expect(socket.sent).toEqual(["watch"]);
    // ! query送信後に不一致、配送対象、終端、終端後のmessageが順に届きます。
    socket.emitMessage("notice:1");
    socket.emitMessage("item:1");
    socket.emitMessage("item:end");
    socket.emitMessage("item:late");

    await expect(subscription.closed).resolves.toEqual({
      ok: true,
      reason: "terminated",
      message: "item:end",
    });
    expect(messages).toEqual(["item:1"]);

    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const failed = client.subscribe({ query, selector, retry: "fail" });
   * const waited = client.subscribe({ query, selector, retry: "wait" });
   * const recovered = client.subscribe({ query, selector, retry: customRecovery });
   * // ! 初回送信後にdropし、代替接続がreadyになる
   * // failは終了し、waitは再送せず、customRecoveryだけが選んだqueryを送信する
   * ```
   */
  it("送信済みsubscribeへfail・wait・custom recoveryを適用する", async () => {
    // 3種類のrecovery policyを持つcallback subscriptionを同じ接続から開始します。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const opening = scenario.beginOpen();
    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    const first = scenario.transport.current;
    const waitedMessages: string[] = [];
    const recoveredMessages: string[] = [];
    const failed = scenario.client.subscribe({
      query: "fail-query",
      selector: () => true,
      retry: "fail",
      next: () => {},
    });
    const waited = scenario.client.subscribe({
      query: "wait-query",
      selector: (message) => message === "wait-response",
      retry: "wait",
      next: (message) => waitedMessages.push(message),
    });
    const recovered = scenario.client.subscribe({
      query: "original-query",
      selector: (message) => message === "original-response",
      retry: {
        recover: () => ({
          query: "recovered-query",
          selector: (message) => message === "recovered-response",
        }),
      },
      next: (message) => recoveredMessages.push(message),
    });
    await flushMicrotasks();
    expect(first.sent).toEqual(["fail-query", "wait-query", "original-query"]);

    // ! 初回送信後に接続がdropし、failだけが直ちに終了します。
    scenario.drop();
    const failedFinalization = await failed.closed;
    expect(failedFinalization.ok).toBe(false);
    if (failedFinalization.ok) throw new Error("failure結果が必要です");
    expect(failedFinalization.reason).toBe("dropped");
    expect(failedFinalization.error).toBeInstanceOf(UniplsDroppedError);
    const recovery = scenario.reconnector.invocations.take();

    // ! 代替接続がreadyになるとcustom recoveryだけがqueryを送信します。
    recovery.reconnect();
    const replacement = scenario.transport.current;
    replacement.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    await flushMicrotasks();
    expect(replacement.sent).toEqual(["recovered-query"]);

    // waitとcustom recoveryは、それぞれ現在のselectorだけで配送します。
    replacement.emitMessage("original-response");
    replacement.emitMessage("wait-response");
    replacement.emitMessage("recovered-response");
    expect(waitedMessages).toEqual(["wait-response"]);
    expect(recoveredMessages).toEqual(["recovered-response"]);

    waited.unsubscribe();
    recovered.unsubscribe();
    await Promise.all([waited.closed, recovered.closed]);
    await closeClient(scenario.client, replacement);
  });

  /**
   * ```ts
   * const timed = client.subscribe({ query, selector, timeout: 100 });
   * const aborted = client.subscribe({ query, selector, signal });
   * const sessionBound = client.subscribe({ query, selector });
   * // ! timeout到達、signal abort、client.close()がそれぞれ発生する
   * // 各closedはtimeout、aborted、closedに対応する終了結果を返す
   * ```
   */
  it("timeout・abort・session closeをsubscribe固有の終了結果へ変換する", async () => {
    // 3つの終了入力を独立に観測できるready clientを用意します。
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
      const controller = new AbortController();
      const abortReason = { code: "stop" };
      const timed = client.subscribe({
        query: "timed",
        selector: () => true,
        timeout: 100,
      });
      const aborted = client.subscribe({
        query: "aborted",
        selector: () => true,
        signal: controller.signal,
      });
      const sessionBound = client.subscribe({
        query: "session-bound",
        selector: () => true,
      });

      // ! 外部signalが既知のreasonでabortします。
      controller.abort(abortReason);
      await expect(aborted.closed).resolves.toEqual({
        ok: false,
        reason: "aborted",
        error: abortReason,
      });

      // ! operation受付から100msが経過します。
      await vi.advanceTimersByTimeAsync(100);
      const timeoutFinalization = await timed.closed;
      expect(timeoutFinalization.ok).toBe(false);
      if (timeoutFinalization.ok) throw new Error("failure結果が必要です");
      expect(timeoutFinalization.reason).toBe("timeout");
      expect(timeoutFinalization.error).toBeInstanceOf(UniplsTimeoutError);

      // ! 利用者がsessionをcloseし、WebSocketのclose handshakeも完了します。
      const closing = client.close();
      await expect(sessionBound.closed).resolves.toEqual({ ok: true, reason: "closed" });
      socket.emitClose();
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
