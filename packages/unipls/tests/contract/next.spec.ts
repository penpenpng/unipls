import { describe, expect, it } from "vite-plus/test";

import { Unipls } from "../../src/index.ts";
import { closeClient, ControlledWebSocketServer, openClient } from "../support/index.ts";

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
});
