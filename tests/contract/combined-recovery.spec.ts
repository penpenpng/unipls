import { describe, expect, it, vi } from "vite-plus/test";

import {
  UniplsBufferOverflowError,
  UniplsDroppedError,
  UniplsTimeoutError,
  type UniplsRecoveryDecision,
} from "../../src/index.ts";
import {
  closeClient,
  ControlledHook,
  flushMicrotasks,
  UniplsRaceScenario,
} from "../support/index.ts";

async function openScenario() {
  const scenario = new UniplsRaceScenario({ detectorCount: 0 });
  const opening = scenario.beginOpen();
  scenario.transport.current.emitOpen();
  scenario.provisioner.succeed(scenario.provisioner.invocations.take());
  await opening;
  return scenario;
}

async function recoverScenario(scenario: UniplsRaceScenario) {
  scenario.reconnector.invocations.take().reconnect();
  const socket = scenario.transport.current;
  socket.emitOpen();
  scenario.provisioner.succeed(scenario.provisioner.invocations.take());
  await scenario.waitForLifecycle(({ phase }) => phase === "open");
  // 再送 Promise の継続で応答の観測が有効になるまで進めます。
  await flushMicrotasks();
  return socket;
}

describe("複数 operation を伴う回復", () => {
  /**
   * ```ts
   * const response = client.request({ query, selector, retry: { recover } });
   * const stream = client.subscribe({ query, selector, retry: { recover } });
   * // ! 接続が回復する
   * // recoverの戻り値に従って再送・待機・終了し、省略したquery/selectorを引き継ぐ
   * ```
   */
  it.each([
    { decision: "wait", sent: [], response: "original" },
    { decision: "undefined", sent: [], response: "original" },
    { decision: "resend", sent: ["query", "query"], response: "original" },
    { decision: "query", sent: ["updated", "updated"], response: "original" },
    { decision: "selector", sent: ["query", "query"], response: "updated" },
    { decision: "fail", sent: [], response: undefined },
  ])("custom recoveryの$decisionをrequestとsubscribeへ同じ意味で適用する", async (testCase) => {
    const scenario = await openScenario();
    const recover = vi.fn((): UniplsRecoveryDecision<string, string> => {
      switch (testCase.decision) {
        case "undefined":
          return undefined;
        case "query":
          return { query: "updated" };
        case "selector":
          return { selector: (message) => message === "updated" };
        case "resend":
          return "resend";
        case "fail":
          return "fail";
        default:
          return "wait";
      }
    });
    const params = {
      query: "query",
      selector: (message: string) => message === "original",
      retry: { recover },
    };
    const response = scenario.client.request(params);
    const stream = scenario.client.subscribe(params);
    await flushMicrotasks();
    // ! 送信後にdropし、同じ2件のoperationを回復します。
    scenario.drop();
    const replacement = await recoverScenario(scenario);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(replacement.sent).toEqual(testCase.sent);
    if (testCase.response === undefined) {
      await expect(response).rejects.toBeInstanceOf(UniplsDroppedError);
      await expect(stream.closed).resolves.toMatchObject({ ok: false, reason: "dropped" });
    } else {
      replacement.emitMessage("ignored");
      if (testCase.response === "updated") replacement.emitMessage("original");
      replacement.emitMessage(testCase.response);
      await expect(response).resolves.toBe(testCase.response);
      await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
        done: false,
        value: testCase.response,
      });
    }
    await closeClient(scenario.client, replacement);
    await stream.closed;
  });

  /**
   * ```ts
   * const stream = client.subscribe({ query, selector, retry: { recover: delayedRecovery } });
   * // ! 回復後のdelayedRecovery完了前にabort、unsubscribe、またはcloseする
   * // ! その後delayedRecoveryがresolveまたはrejectする
   * // queryを再送せず、先に確定したclosedとiteratorの結果を維持する
   * ```
   */
  it.each([
    { ending: "abort", settlement: "resolve" },
    { ending: "abort", settlement: "reject" },
    { ending: "unsubscribe", settlement: "resolve" },
    { ending: "unsubscribe", settlement: "reject" },
    { ending: "close", settlement: "resolve" },
    { ending: "close", settlement: "reject" },
  ])("非同期recoveryの$settlementより先の$endingを確定する", async ({ ending, settlement }) => {
    const scenario = await openScenario();
    const recovery = new ControlledHook<unknown, UniplsRecoveryDecision<string, string>>();
    const controller = new AbortController();
    const cause = new Error("stop");
    const lateQuery = vi.fn(() => "late-query");
    const stream = scenario.client.subscribe({
      query: "watch",
      selector: () => true,
      retry: { recover: recovery.invoke },
      signal: controller.signal,
    });
    await flushMicrotasks();
    // ! drop後に接続は回復しますが、operationの回復判断は保留します。
    scenario.drop();
    const replacement = await recoverScenario(scenario);
    const invocation = recovery.invocations.take();
    replacement.emitMessage("before-decision");
    const pending = stream[Symbol.asyncIterator]().next();
    const pendingAssertion =
      ending === "abort"
        ? expect(pending).rejects.toBe(cause)
        : expect(pending).resolves.toEqual({ done: true, value: undefined });
    // ! operationまたはsessionの終了が、回復判断より先に確定します。
    if (ending === "abort") controller.abort(cause);
    else if (ending === "unsubscribe") stream.unsubscribe();
    else await closeClient(scenario.client, replacement);
    const finalization = await stream.closed;
    await pendingAssertion;
    expect(finalization).toEqual(
      ending === "abort"
        ? { ok: false, reason: "aborted", error: cause }
        : { ok: true, reason: ending === "close" ? "closed" : "unsubscribed" },
    );
    // ! 終了後に非同期の回復判断が返ります。
    if (settlement === "resolve") invocation.resolve({ query: lateQuery });
    else invocation.reject(new Error("late recovery failure"));
    await flushMicrotasks();
    expect(lateQuery).not.toHaveBeenCalled();
    expect(replacement.sent).toEqual([]);
    expect(await stream.closed).toBe(finalization);
    if (ending !== "close") await closeClient(scenario.client, replacement);
  });

  /**
   * ```ts
   * const response = client.request({ query, selector, retry: "resend" });
   * const stream = client.subscribe({ query, selector, retry: "resend" });
   * const listener = client.listen({ onMessage: consume });
   * // ! 2回のdropと再接続が発生する
   * await response; // 各readyで一度ずつ再送し、最後の接続で応答を受信する
   * // streamの未処理messageとlistenerは同じ論理sessionで継続する
   * ```
   */
  it("2回の回復でrequest・subscribeを一度ずつ再送しlistenとbufferを維持する", async () => {
    const scenario = await openScenario();
    const first = scenario.transport.current;
    const requestQuery = vi.fn(() => "request");
    const subscribeQuery = vi.fn(() => "watch");
    const response = scenario.client.request({
      query: requestQuery,
      selector: (message) => message === "response",
      retry: "resend",
    });
    const stream = scenario.client.subscribe({
      query: subscribeQuery,
      selector: (message) => message.startsWith("item:"),
      retry: "resend",
      buffer: 3,
    });
    const observed: string[] = [];
    const listener = scenario.client.listen({ onMessage: (message) => observed.push(message) });
    await flushMicrotasks();
    expect(first.sent).toEqual(["request", "watch"]);
    first.emitMessage("item:1");

    for (const item of ["item:2", "item:3"]) {
      const obsolete = scenario.transport.current;
      // ! 接続が切れ、代替接続のprovisioning中にもmessageが届きます。
      scenario.drop();
      scenario.reconnector.invocations.take().reconnect();
      const replacement = scenario.transport.current;
      replacement.emitOpen();
      replacement.emitMessage("item:before-ready");
      expect(replacement.sent).toEqual([]);
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await scenario.waitForLifecycle(({ phase }) => phase === "open");
      await flushMicrotasks();
      expect(replacement.sent).toEqual(["request", "watch"]);
      // ! 失効した接続のmessageはbufferにもlistenerにも届きません。
      obsolete.emitMessage("item:stale");
      replacement.emitMessage(item);
    }

    const iterator = stream[Symbol.asyncIterator]();
    for (const value of ["item:1", "item:2", "item:3"]) {
      await expect(iterator.next()).resolves.toEqual({ done: false, value });
    }
    expect(observed).toEqual(["item:1", "item:2", "item:3"]);
    expect(requestQuery).toHaveBeenCalledTimes(3);
    expect(subscribeQuery).toHaveBeenCalledTimes(3);
    scenario.transport.current.emitMessage("response");
    await expect(response).resolves.toBe("response");
    const pending = iterator.next();
    await closeClient(scenario.client, scenario.transport.current);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(stream.closed).resolves.toEqual({ ok: true, reason: "closed" });
    await expect(listener.closed).resolves.toEqual({ ok: true, reason: "closed" });
  });

  /**
   * ```ts
   * const response = client.request({ query, selector, retry: "resend", signal });
   * const stream = client.subscribe({ query, selector, retry: "resend", timeout: 50 });
   * // ! drop後、signalがabortし、再接続の準備中にtimeoutに到達する
   * // これらは再送されず、独立したsubscribeだけが再開する
   * ```
   */
  it("回復待機中のabortとprovisioning中のtimeoutを隔離し終了済みqueryを再送しない", async () => {
    vi.useFakeTimers();
    try {
      const scenario = await openScenario();
      const controller = new AbortController();
      const cause = new Error("cancel request");
      const abortedQuery = vi.fn(() => "aborted");
      const timedQuery = vi.fn(() => "timed");
      const response = scenario.client.request({
        query: abortedQuery,
        selector: () => true,
        retry: "resend",
        signal: controller.signal,
      });
      const timed = scenario.client.subscribe({
        query: timedQuery,
        selector: () => true,
        retry: "resend",
        timeout: 50,
      });
      const survivor = scenario.client.subscribe({
        query: "survivor",
        selector: () => true,
        retry: "resend",
      });
      const timedNext = timed[Symbol.asyncIterator]().next();
      const timeoutAssertion = expect(timedNext).rejects.toBeInstanceOf(UniplsTimeoutError);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(20);
      // ! 接続が切れ、回復を待つrequestが中断されます。
      scenario.drop();
      controller.abort(cause);
      await expect(response).rejects.toBe(cause);
      scenario.reconnector.invocations.take().reconnect();
      const replacement = scenario.transport.current;
      replacement.emitOpen();
      // ! 受付から50msが経過します。再接続でdeadlineは延長されません。
      await vi.advanceTimersByTimeAsync(30);
      await timeoutAssertion;
      await expect(timed.closed).resolves.toMatchObject({
        ok: false,
        reason: "timeout",
        error: expect.any(UniplsTimeoutError),
      });
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await scenario.waitForLifecycle(({ phase }) => phase === "open");
      await flushMicrotasks();
      expect(replacement.sent).toEqual(["survivor"]);
      expect(abortedQuery).toHaveBeenCalledTimes(1);
      expect(timedQuery).toHaveBeenCalledTimes(1);
      replacement.emitMessage("live");
      await expect(survivor[Symbol.asyncIterator]().next()).resolves.toEqual({
        done: false,
        value: "live",
      });
      await closeClient(scenario.client, replacement);
      await expect(survivor.closed).resolves.toEqual({ ok: true, reason: "closed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ```ts
   * const stream = client.subscribe({ query, selector, retry: "resend", buffer: 1 });
   * // ! 未処理messageを残したまま回復し、次のmessageでbufferが満杯になる
   * await stream.closed; // buffer-overflow
   * // 独立したrequestとlistenは継続し、次の回復でstreamは再送されない
   * ```
   */
  it("回復をまたぐbuffer overflowを他のoperationから隔離し次の再送を解除する", async () => {
    const scenario = await openScenario();
    const stream = scenario.client.subscribe({
      query: "watch",
      selector: () => true,
      retry: "resend",
      buffer: 1,
    });
    const observed: string[] = [];
    const listener = scenario.client.listen({ onMessage: (message) => observed.push(message) });
    await flushMicrotasks();
    scenario.transport.current.emitMessage("buffered");
    // ! 未処理messageがある状態で接続を回復します。
    scenario.drop();
    const second = await recoverScenario(scenario);
    expect(second.sent).toEqual(["watch"]);
    const response = scenario.client.request({ query: "request", selector: () => true });
    await flushMicrotasks();
    second.emitMessage("overflow");
    const finalization = await stream.closed;
    expect(finalization).toMatchObject({
      ok: false,
      reason: "buffer-overflow",
      error: expect.any(UniplsBufferOverflowError),
    });
    if (finalization.ok) throw new Error("failure結果が必要です");
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(finalization.error);
    await expect(response).resolves.toBe("overflow");
    // ! 再び接続を回復しても、終了したstreamのqueryは送信しません。
    scenario.drop();
    const third = await recoverScenario(scenario);
    expect(third.sent).toEqual([]);
    third.emitMessage("after");
    expect(observed).toEqual(["buffered", "overflow", "after"]);
    expect(await stream.closed).toBe(finalization);
    await closeClient(scenario.client, third);
    await expect(listener.closed).resolves.toEqual({ ok: true, reason: "closed" });
  });
});
