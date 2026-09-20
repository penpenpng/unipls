import { describe, expect, it } from "vite-plus/test";

import { flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

describe("Unipls.open の ready 契約", () => {
  /**
   * ```ts
   * const opening = client.open(async () => {
   *   // ! WebSocket が接続し、provisioning が開始される
   *   await authenticate(); // この処理が完了するまで opening は未完了
   * });
   * await opening; // WebSocket 接続と provisioning の両方が成功済み
   * ```
   */
  it("provisioning が成功するまで open を未完了に保つ", async () => {
    // open の Promise と、その完了状態を独立に観測します。
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    const transport = scenario.transport.connection(0);
    let settled = false;
    void opening.finally(() => {
      settled = true;
    });

    // WebSocket を開き、制御 hook で provisioning を保留します。
    transport.emitOpen();
    const provisioning = scenario.provisioner.invocations.take();
    // microtask を進め、WebSocket の open だけでは完了しないことを確認します。
    await flushMicrotasks();
    expect(settled).toBe(false);

    // provisioning を成功させ、元の open が完了することを確認します。
    scenario.provisioner.succeed(provisioning);
    await opening;
    expect(settled).toBe(true);

    // ready になった接続を終了します。
    const closing = scenario.client.close();
    transport.emitClose({ code: 1000, wasClean: true });
    await closing;
  });
});
