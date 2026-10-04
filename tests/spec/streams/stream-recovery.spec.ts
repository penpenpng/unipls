import { describe, expect, it, vi } from "vite-plus/test";

import { Unipls, UniplsTimeoutError } from "../../../src/index.ts";
import {
  closeClient,
  ControlledWebSocketServer,
  flushMicrotasks,
  openClient,
  UniplsRaceScenario,
} from "../../support/index.ts";

describe("stream の recovery", () => {
  /**
   * ```ts
   * // ! clientがrecovery中で次の接続を待っている
   * const subscription = client.listen({ onMatch: consume, timeout: 100 });
   * // provisioning中のmessageはconsumeへ届かない
   * // ! 代替接続がreadyになり、その後application messageが届く
   * // ready後だけconsumeへ届き、timeoutは最初の受付時から継続する
   * ```
   */
  it("recovery 中に作った listen を次の ready から開始して deadline を維持する", async () => {
    vi.useFakeTimers();
    try {
      const scenario = new UniplsRaceScenario();
      const opening = scenario.beginOpen();
      scenario.transport.current.emitOpen();
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await opening;
      scenario.drop();
      const recovery = scenario.reconnector.invocations.take();
      const received: string[] = [];
      const subscription = scenario.client.listen({
        onMatch: (message) => received.push(message),
        timeout: 100,
      });
      await vi.advanceTimersByTimeAsync(90);
      recovery.reconnect();
      const replacement = scenario.transport.current;
      replacement.emitOpen();
      replacement.emitMessage("provisioning");
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await scenario.waitForLifecycle(({ phase }) => phase === "open");
      replacement.emitMessage("application");
      expect(received).toEqual(["application"]);
      await vi.advanceTimersByTimeAsync(10);
      const finalization = await subscription.closed;
      expect(finalization.ok).toBe(false);
      if (finalization.ok) {
        throw new Error("Expected failure");
      }
      expect(finalization.reason).toBe("timeout");
      expect(finalization.error).toBeInstanceOf(UniplsTimeoutError);

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
   * const subscription = client.subscribe({
   *   query: () => {
   *     throw factoryError;
   *   },
   *   selector,
   * });
   * // query factoryの失敗をfatal-errorとしてiterationとclosedへ同じ値で通知する
   * ```
   */
  it("subscribe の query factory failure を同じ fatal error で終了する", async () => {
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const cause = new Error("query factory failed");
    const subscription = client.subscribe({
      query: () => {
        throw cause;
      },
      selector: () => true,
    });
    const iterator = subscription[Symbol.asyncIterator]();
    const finalization = await subscription.closed;
    expect(finalization).toEqual({ ok: false, reason: "fatal-error", error: cause });
    await expect(iterator.next()).rejects.toBe(cause);
    expect(socket.sent).toEqual([]);
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const subscription = client.subscribe({
   *   query: factory,
   *   selector,
   *   retry: "resend",
   * });
   * // ! 初回送信後にdropし、代替接続がreadyになる
   * // factoryを再評価して再送し、代替接続のmessageをiterationできる
   * subscription.unsubscribe();
   * ```
   */
  it("subscribe を明示的な resend 後も同じ AsyncSubscription として継続する", async () => {
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    let factoryCalls = 0;
    const subscription = scenario.client.subscribe({
      query: () => `subscribe-${++factoryCalls}`,
      selector: (message) => message.startsWith("message"),
      retry: "resend",
    });
    await flushMicrotasks();
    expect(scenario.transport.current.sent).toEqual(["subscribe-1"]);

    // ! drop後の代替readyでfactoryを再評価して一度だけ再送します。
    scenario.drop();
    const recovery = scenario.reconnector.invocations.take();
    recovery.reconnect();
    const replacement = scenario.transport.current;
    replacement.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    await flushMicrotasks();
    expect(replacement.sent).toEqual(["subscribe-2"]);
    const iterator = subscription[Symbol.asyncIterator]();
    replacement.emitMessage("message-after-recovery");
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "message-after-recovery",
    });
    subscription.unsubscribe();
    await expect(subscription.closed).resolves.toEqual({ ok: true, reason: "unsubscribed" });
    await closeClient(scenario.client, replacement);
  });
});
