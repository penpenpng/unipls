import { describe, expect, it } from "vite-plus/test";

import { Unipls } from "../../src/index.ts";
import { closeClient, ControlledWebSocketServer } from "../support/index.ts";

describe("Unipls.cast の主要シナリオ", () => {
  /**
   * ```ts
   * const opening = client.open({
   *   setupConnection: () => provisioningGate,
   * });
   * const sending = client.cast({ query: () => createMessage() });
   * // ! WebSocket は接続済みだが、provisioning はまだ完了していない
   * await provisioningGate; // この時点でcreateMessage()を評価して送信する
   * await Promise.all([opening, sending]);
   * ```
   */
  it("ready になるまでqueryの評価と送信を待ち、送信完了後に解決する", async () => {
    // provisioningの完了を制御できるclientと、評価回数を観測できるqueryを用意します。
    const transport = new ControlledWebSocketServer();
    let finishProvisioning!: () => void;
    const provisioningGate = new Promise<void>((resolve) => {
      finishProvisioning = resolve;
    });
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    let queryEvaluations = 0;
    const opening = client.open({
      setupConnection: () => provisioningGate,
    });

    // ! WebSocketが接続し、未完了のprovisioningが開始されます。
    const socket = transport.current;
    socket.emitOpen();
    const sending = client.cast({
      query: () => `message-${++queryEvaluations}`,
    });
    expect(queryEvaluations).toBe(0);
    expect(socket.sent).toEqual([]);

    // provisioning完了後にqueryを一度だけ評価し、その値を現在の接続へ送信します。
    finishProvisioning();
    await opening;
    await expect(sending).resolves.toBeUndefined();
    expect(queryEvaluations).toBe(1);
    expect(socket.sent).toEqual(["message-1"]);

    await closeClient(client, socket);
  });
});
