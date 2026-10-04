import { describe, expect, it } from "vite-plus/test";

import { Unipls } from "../../../src/index.ts";
import { closeClient, ControlledWebSocketServer } from "../../support/index.ts";

describe("Unipls.request の主要シナリオ", () => {
  /**
   * ```ts
   * const response = client.request({ query: "ping", selector: isPong });
   * // ! ready前にpongが届いても、queryをまだ送信していないため応答とはみなさない
   * await opening; // pingを送信し、ここから応答を観測する
   * // ! 送信後にpongが届く
   * await response; // 送信後に最初に一致したpongで解決する
   * ```
   */
  it("queryを送信した後のmessageだけを応答候補として観測する", async () => {
    // provisioningを止め、requestの初回送信前後を明確に分けます。
    const transport = new ControlledWebSocketServer();
    let finishProvisioning!: () => void;
    const provisioningGate = new Promise<void>((resolve) => {
      finishProvisioning = resolve;
    });
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    let selectorCalls = 0;
    const opening = client.open({ setupConnection: () => provisioningGate });

    // ! WebSocketが接続し、未完了のprovisioningが開始されます。
    const socket = transport.current;
    socket.emitOpen();
    const response = client.request({
      query: "ping",
      selector: (message) => {
        selectorCalls += 1;
        return message === "pong";
      },
    });

    // ! query送信前に同じ形のresponseが届いてもselectorへ渡しません。
    socket.emitMessage("pong");
    expect(selectorCalls).toBe(0);
    expect(socket.sent).toEqual([]);

    // readyへ進むとqueryを送信し、それ以降のmessageを応答候補として選びます。
    finishProvisioning();
    await opening;
    expect(socket.sent).toEqual(["ping"]);
    // ! query送信後に不一致のmessageとresponseが届きます。
    socket.emitMessage("notice");
    socket.emitMessage("pong");
    await expect(response).resolves.toBe("pong");
    expect(selectorCalls).toBe(2);

    await closeClient(client, socket);
  });
});
