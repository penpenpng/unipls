import { describe, expect, it } from "vite-plus/test";

import { Unipls } from "../../src/index.ts";
import { closeClient, ControlledWebSocketServer, openClient } from "../support/index.ts";

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
});
