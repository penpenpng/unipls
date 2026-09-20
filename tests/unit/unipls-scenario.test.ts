import { describe, expect, it } from "vite-plus/test";

import { flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

describe("UniplsRaceScenario の test harness", () => {
  it("古い接続と複数 detector の競合を決定的に組み立てる", async () => {
    // 2つの detector が開始された ready 接続を作ります。
    const scenario = new UniplsRaceScenario({ detectorCount: 2 });
    const opening = scenario.beginOpen();
    const first = scenario.transport.connection(0);

    first.emitOpen();
    const provisioning = scenario.provisioner.invocations.take();
    scenario.provisioner.succeed(provisioning);
    await opening;

    // 2つの detector が同じ接続用の独立した context を受け取ることを確認します。
    const firstDetector = scenario.detectors[0].invocations.take();
    const secondDetector = scenario.detectors[1].invocations.take();
    expect(firstDetector.context).not.toBe(secondDetector.context);

    // 複数の detector 報告、transport error、close event を競合させます。
    secondDetector.drop();
    firstDetector.drop();
    first.emitError(new Error("late transport error"));
    scenario.drop(0);
    const reconnect = scenario.reconnector.invocations.take();
    reconnect.reconnect();
    expect(scenario.transport.connections).toHaveLength(2);

    // 最初の接続の古い event を再現し、遅延した継続を進めます。
    scenario.emitStaleMessage(0, "late message");
    scenario.emitStaleClose(0, { code: 4100, wasClean: false });
    await flushMicrotasks();

    // scenario が古い socket と代替 socket を別々に保持することを確認します。
    expect(scenario.transport.connection(0)).toBe(first);
    expect(scenario.transport.connection(1)).not.toBe(first);

    // 接続中の代替 socket を終了します。
    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("実時間を待たずに二重 open を組み立てる", async () => {
    // 1回目の open を開始し、2回目の open を同期的に競合させます。
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();

    expect(() => scenario.attemptSecondOpen()).toThrow();

    // 2回目が拒否された後、元の open を完了します。
    const first = scenario.transport.connection(0);
    first.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;

    // 元の接続を終了します。
    const closing = scenario.client.close();
    first.emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it.each(["close", "reconnect"] as const)(
    "%s が勝つ close/reconnect の競合を組み立てる",
    async (winner) => {
      // close/reconnect の競合前に ready 接続を作ります。
      const scenario = new UniplsRaceScenario();
      const opening = scenario.beginOpen();
      const first = scenario.transport.connection(0);
      first.emitOpen();
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await opening;

      // 接続を drop し、2つの操作を指定順で実行します。
      scenario.drop(0);
      const reconnection = scenario.reconnector.invocations.take();
      const closing = scenario.raceCloseAndReconnect(reconnection, winner);

      // reconnect が socket を作った場合は close event を発火して明示 close を完了させます。
      if (winner === "reconnect") {
        scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
      }
      await closing;

      // reconnect が先の場合だけ新しい接続が作られることを確認します。
      expect(scenario.transport.connections).toHaveLength(winner === "reconnect" ? 2 : 1);
    },
  );
});
