import { describe, expect, it } from "vite-plus/test";

import { UniplsClosedError, UniplsInvalidUsageError } from "../../../src/index.ts";
import { flushMicrotasks, UniplsRaceScenario } from "../../support/index.ts";

describe("Unipls.open の ready 契約", () => {
  /**
   * ```ts
   * const opening = client.open({
   *   async setupConnection() {
   *     // ! WebSocket が接続し、provisioning が開始される
   *     await authenticate(); // この処理が完了するまで opening は未完了
   *   },
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

  /**
   * ```ts
   * // 削除済みのfunction shorthandや必須hookのないobjectは受け付けない
   * client.open(async () => authenticate()); // 同期的にTypeError
   * client.open({ setupSession }); // 同期的にTypeError
   * ```
   */
  it("provisioner の公開形を session 作成前に同期的に検証する", () => {
    // 型検査を迂回したJavaScript相当の入力と、まだidleなclientを用意します。
    const scenario = new UniplsRaceScenario();
    const idle = scenario.client.lifecycle;
    const unsafe = scenario.client as unknown as { open(provisioner: unknown): unknown };

    // function shorthand、必須hook欠落、hook型不正をTypeErrorとして拒否します。
    const invalidProvisioners = [
      () => unsafe.open(() => {}),
      () => unsafe.open({ setupSession() {} }),
      () => unsafe.open({ setupConnection: true }),
      () => unsafe.open({ setupConnection() {}, setupSession: true }),
    ];

    for (const open of invalidProvisioners) {
      expect(open).toThrow(TypeError);
      expect(open).not.toThrow(UniplsInvalidUsageError);
    }

    // 不正入力は論理sessionもWebSocket接続も作りません。
    expect(scenario.client.lifecycle).toBe(idle);
    expect(scenario.transport.connections).toHaveLength(0);
  });

  /**
   * ```ts
   * const opening = client.open({ setupConnection: () => provisioningGate });
   * const sending = client.cast({ query: "pending" });
   * // ! provisioning完了前に利用者がclient.close()を呼ぶ
   * await opening; // UniplsClosedErrorでrejectする
   * await sending; // 保留中の送信も同じsessionとともに終了し、次のopenへ持ち越さない
   * ```
   */
  it("provisioning中のcloseでopenと保留送信を終了して次のsessionへ持ち越さない", async () => {
    // provisioningを保留した初回sessionでcastを受け付けます。
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    const first = scenario.transport.current;

    first.emitOpen();
    const obsoleteProvisioning = scenario.provisioner.invocations.take();
    const sending = scenario.client.cast({ query: "pending" });

    expect(first.sent).toEqual([]);

    // ! 利用者がprovisioning完了前にcloseし、WebSocketのclose handshakeも完了します。
    const closing = scenario.client.close();

    first.emitClose();
    await closing;
    await expect(opening).rejects.toBeInstanceOf(UniplsClosedError);
    await expect(sending).rejects.toBeInstanceOf(UniplsClosedError);
    expect(first.sent).toEqual([]);

    // 失効したprovisioningが後から完了しても、旧payloadを送信しません。
    scenario.provisioner.succeed(obsoleteProvisioning);
    await flushMicrotasks();
    expect(first.sent).toEqual([]);

    // 次のopenは新しいsessionとして成立し、旧castを引き継ぎません。
    const reopening = scenario.beginOpen();
    const second = scenario.transport.current;

    second.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await reopening;
    expect(second.sent).toEqual([]);
    const finalClosing = scenario.client.close();

    second.emitClose();
    await finalClosing;
  });
});
