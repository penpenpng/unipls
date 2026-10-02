import { describe, expect, it, vi } from "vite-plus/test";

import { UniplsSocket } from "../../src/socket.ts";
import {
  ControlledWebSocketServer,
  flushMicrotasks,
  UniplsRaceScenario,
} from "../support/index.ts";

describe("接続試行の分離", () => {
  /**
   * ```ts
   * const client = new Unipls({ url, reconnector, dropDetectors: [detector] });
   * client.on("message", consume);
   * await client.open(provisioner);
   * // ! 接続が drop し、reconnector が新しい接続試行を開始する
   * // ! その後、古い WebSocket の event や detector の callback が発生する
   * // 古い callback は
   * // message、log、drop、lifecycle のいずれも変更しない
   * ```
   */
  it("回復試行の開始後は古い接続のイベントを無視する", async () => {
    // 公開 event の observer を登録し、最初の接続を ready にします。
    const scenario = new UniplsRaceScenario({ detectorCount: 1 });
    const messages: string[] = [];
    scenario.client.on("message", ({ message }) => messages.push(message));

    const opening = scenario.beginOpen();
    const first = scenario.transport.connection(0);
    first.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    const firstDetector = scenario.detectors[0].invocations.take();

    // 最初の接続を drop し、代替接続を open 前で保留します。
    scenario.drop(0);
    const recovery = scenario.reconnector.invocations.take();
    recovery.reconnect();
    const reconnecting = scenario.client.lifecycle;

    // 最初の接続が保持していた detector を含む、すべての古い callback を再現します。
    first.emitOpen();
    first.emitMessage("stale message");
    first.emitError(new Error("stale error"));
    first.emitClose({ code: 4100, wasClean: false });
    firstDetector.drop();
    // microtask を進め、古い非同期継続があれば観測可能にします。
    await flushMicrotasks();

    // 古い処理が lifecycle、公開 event、新しい socket のどれも変更しないことを確認します。
    expect(scenario.client.lifecycle).toBe(reconnecting);
    expect(messages).toEqual([]);
    expect(scenario.logs).toEqual([]);
    expect(scenario.transport.connection(1).closeRequests).toEqual([]);
    expect(firstDetector.cleanupCount).toBe(1);
    expect(first.listenerCount("open")).toBe(0);
    expect(first.listenerCount("message")).toBe(0);
    expect(first.listenerCount("error")).toBe(0);
    expect(first.listenerCount("close")).toBe(0);

    // 現在の代替接続を ready にしてから終了します。
    const second = scenario.transport.connection(1);
    second.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");

    const closing = scenario.client.close();
    second.emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  /**
   * ```ts
   * await client.open({
   *   setupConnection: async () => delayedSetup(),
   * });
   * // ! 再接続の provisioning 中にその接続が再び drop する
   * // ! 失効後に delayedSetup() が完了する
   * // delayedSetup() が完了しても、
   * // その接続の open event や detector resource は作られない
   * ```
   */
  it("遅延した provisioning が古い接続を ready に戻さない", async () => {
    // 初回セッションを ready にし、公開 open event を記録します。
    const scenario = new UniplsRaceScenario({ detectorCount: 1 });
    const opened: unknown[] = [];
    scenario.client.on("open", (event) => opened.push(event));

    const opening = scenario.beginOpen();
    scenario.transport.connection(0).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    scenario.detectors[0].invocations.take();

    // 2つ目の接続を開始し、provisioning の完了を保留します。
    scenario.drop(0);
    scenario.reconnector.invocations.take().reconnect();
    scenario.transport.connection(1).emitOpen();
    const obsoleteProvisioning = scenario.provisioner.invocations.take();

    // provisioning 中の接続を drop し、現在の3つ目の試行を開始します。
    scenario.drop(1);
    await flushMicrotasks();
    scenario.reconnector.invocations.take().reconnect();
    const currentConnecting = scenario.client.lifecycle;

    // 古い hook を解放し、その非同期継続を進めます。
    scenario.provisioner.succeed(obsoleteProvisioning);
    await flushMicrotasks();

    // 古い接続が ready 通知も detector resource も公開しないことを確認します。
    expect(scenario.client.lifecycle).toBe(currentConnecting);
    expect(opened).toHaveLength(1);
    expect(scenario.detectors[0].invocations.size).toBe(0);

    // 3つ目の接続を完了し、ready への遷移を待ちます。
    const current = scenario.transport.connection(2);
    current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    expect(opened).toHaveLength(2);
    expect(scenario.detectors[0].invocations.size).toBe(1);
    const currentDetector = scenario.detectors[0].invocations.take();

    // 有効な接続を終了します。
    const closing = scenario.client.close();
    current.emitClose({ code: 1000, wasClean: true });
    await closing;
    expect(currentDetector.cleanupCount).toBe(1);
  });

  /**
   * ```ts
   * const opening = socket.open();
   * const sending = socket.enqueue(payload, { force: true }); // この接続に束縛される
   * // ! WebSocket が接続しないまま timeout に到達する
   * await opening.catch(handleConnectionError);
   * await sending.catch(handleSendError); // 同じ接続の失敗で終了する
   * const nextOpening = socket.open();
   * // ! 次の WebSocket が接続する
   * await nextOpening; // payload は次の WebSocket へ送られない
   * ```
   */
  it("送信待機を開始時と同じ接続の socket に束縛する", async () => {
    // 仮想時間を使い、実時間を待たずに最初の接続を timeout させます。
    vi.useFakeTimers();
    try {
      const transport = new ControlledWebSocketServer();
      const socket = new UniplsSocket<string, string>({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
        timeout: 100,
      });

      // 最初の socket が接続中に強制送信を待機させ、接続を timeout させます。
      const firstOpening = socket.open();
      const firstSend = socket.enqueue("obsolete", { force: true });
      const first = transport.connection(0);
      await vi.advanceTimersByTimeAsync(100);
      await expect(firstOpening).rejects.toThrow();

      // 代替接続を開き、古い payload が新しい socket へ移らないことを確認します。
      const secondOpening = socket.open();
      const second = transport.connection(1);
      second.emitOpen();
      await secondOpening;

      // 最初の接続について、失敗、socket の所有関係、callback と listener の解放を確認します。
      await expect(firstSend).rejects.toThrow();
      expect(first.sent).toEqual([]);
      expect(second.sent).toEqual([]);
      expect(first.listenerCount("open")).toBe(0);
      expect(first.listenerCount("message")).toBe(0);
      expect(first.listenerCount("error")).toBe(0);
      expect(first.listenerCount("close")).toBe(0);

      // 2つ目の接続を閉じ、すべての仮想 timer が解放されたことを確認します。
      const closing = socket.close();
      second.emitClose({ code: 1000, wasClean: true });
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // assertion が失敗した場合も実行環境の timer を復元します。
      vi.useRealTimers();
    }
  });
});
