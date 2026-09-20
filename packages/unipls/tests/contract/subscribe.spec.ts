import { describe, expect, it } from "vite-plus/test";

import { Unipls } from "../../src/index.ts";
import { closeClient, ControlledWebSocketServer } from "../support/index.ts";

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
});
