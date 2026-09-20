import { describe, expect, it } from "vite-plus/test";

import { Unipls, UniplsDroppedError } from "../../src/index.ts";
import { closeClient, ControlledWebSocketServer, openClient } from "../support/index.ts";
import { UniplsRaceScenario } from "../support/index.ts";

describe("Unipls.listen の主要シナリオ", () => {
  /**
   * ```ts
   * const subscription = client.listen({
   *   selector: isItem,
   *   terminator: isEnd,
   *   next: consumeItem,
   * });
   * // ! item、終端message、終端後のitemがWebSocketから届く
   * await subscription.closed; // 終端messageは配送せずterminatedで終了する
   * ```
   */
  it("selectorに一致するmessageを継続配送し、terminatorで購読を終了する", async () => {
    // readyなclientへ、終端messageもselectorに一致する購読を登録します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const messages: string[] = [];
    const subscription = client.listen({
      selector: (message) => message.startsWith("item:"),
      terminator: (message) => message === "item:end",
      next: (message) => messages.push(message),
    });

    // ! serverから不一致、配送対象、終端、終端後の配送対象が順に届きます。
    socket.emitMessage("notice:1");
    socket.emitMessage("item:1");
    socket.emitMessage("item:end");
    socket.emitMessage("item:late");

    // terminatorをselectorより先に適用し、終端message自体と後続messageは配送しません。
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
   * const failed = client.listen({ next: consume, retry: "fail" });
   * const waited = client.listen({ next: consume, retry: "wait" });
   * // ! ready接続がdropし、代替接続がreadyになってmessageが届く
   * await failed.closed; // droppedで終了する
   * await waited.closed; // 終了せず、代替接続のmessageを配送する
   * ```
   */
  it("drop時にfailを終了し、waitを同じsubscriptionのまま再開する", async () => {
    // 同じsessionへfailとwaitのcallback subscriptionを登録します。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const opening = scenario.beginOpen();
    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    const failedMessages: string[] = [];
    const waitedMessages: string[] = [];
    const failed = scenario.client.listen({
      retry: "fail",
      next: (message) => failedMessages.push(message),
    });
    const waited = scenario.client.listen({
      retry: "wait",
      next: (message) => waitedMessages.push(message),
    });

    // ! ready接続がdropすると、failだけがcanonical dropで終了します。
    scenario.drop();
    const failedFinalization = await failed.closed;
    expect(failedFinalization.ok).toBe(false);
    if (failedFinalization.ok) throw new Error("failure結果が必要です");
    expect(failedFinalization.reason).toBe("dropped");
    expect(failedFinalization.error).toBeInstanceOf(UniplsDroppedError);
    const recovery = scenario.reconnector.invocations.take();

    // ! 代替接続がreadyになった後にapplication messageが届きます。
    recovery.reconnect();
    const replacement = scenario.transport.current;
    replacement.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    replacement.emitMessage("after-recovery");
    expect(failedMessages).toEqual([]);
    expect(waitedMessages).toEqual(["after-recovery"]);

    waited.unsubscribe();
    await expect(waited.closed).resolves.toEqual({ ok: true, reason: "unsubscribed" });
    await closeClient(scenario.client, replacement);
  });
});
