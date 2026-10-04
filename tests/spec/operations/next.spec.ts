import { describe, expect, it } from "vite-plus/test";

import { Unipls, UniplsDroppedError } from "../../../src/index.ts";
import { closeClient, ControlledWebSocketServer, openClient } from "../../support/index.ts";
import { flushMicrotasks, UniplsRaceScenario } from "../../support/index.ts";

describe("Unipls.next の主要シナリオ", () => {
  /**
   * ```ts
   * const nextPong = client.next({ selector: (message) => message.type === "pong" });
   * // ! selectorに一致しないmessageに続いてpongがWebSocketから届く
   * const pong = await nextPong; // 最初に一致したpongで解決する
   * ```
   */
  it("一致しないmessageを読み飛ばし、selectorに最初に一致するmessageを返す", async () => {
    // readyなclientで、受信messageの種別を選ぶ単発operationを開始します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const selected = client.next({ selector: (message) => message.startsWith("pong:") });

    // ! serverから不一致のmessage、一致するmessage、その後のmessageの順に届きます。
    socket.emitMessage("notice:1");
    socket.emitMessage("pong:1");
    socket.emitMessage("pong:2");

    // operationは最初に一致した1件だけで解決します。
    await expect(selected).resolves.toBe("pong:1");
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const failed = client.next({ selector, retry: "fail" });
   * const waited = client.next({ selector, retry: "wait" });
   * // ! ready接続がdropし、その後に代替接続がreadyになる
   * await failed; // drop時にUniplsDroppedErrorで終了する
   * await waited; // 代替接続で最初に一致するmessageを待ち続ける
   * ```
   */
  it("drop時にfailを終了し、waitを代替接続のready後から再開する", async () => {
    // retry policyが異なる2つのnextをready sessionへ登録します。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const opening = scenario.beginOpen();

    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    const failed = scenario.client.next({ selector: () => true, retry: "fail" });
    const waited = scenario.client.next({ selector: (message) => message === "selected" });

    // ! 現在のready接続がdropすると、failだけがそのdropで終了します。
    scenario.drop();
    await expect(failed).rejects.toBeInstanceOf(UniplsDroppedError);
    const recovery = scenario.reconnector.invocations.take();

    // ! 代替接続がreadyになり、その後に一致messageが届きます。
    recovery.reconnect();
    const replacement = scenario.transport.current;

    replacement.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    replacement.emitMessage("selected");
    await expect(waited).resolves.toBe("selected");
    await flushMicrotasks();

    await closeClient(scenario.client, replacement);
  });
});
