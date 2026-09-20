import { describe, expect, it } from "vite-plus/test";

import { ControlledWebSocket, ControlledWebSocketServer } from "../support/index.ts";

describe("ControlledWebSocketServer の test harness", () => {
  it("古いイベントを含めて呼び出し側が指定した順序で transport event を発火する", () => {
    // 制御可能な socket を作り、property handler の呼び出しを記録します。
    const server = new ControlledWebSocketServer();
    const socket = new server.WebSocket("wss://unipls.test") as unknown as ControlledWebSocket;
    const events: string[] = [];

    socket.onclose = (event) => events.push(`close:${event.code}`);
    socket.onmessage = (event) => events.push(`message:${event.data}`);
    socket.onopen = () => events.push("open");

    // 古い transport event を再現するため、通常とは異なる順序で発火します。
    socket.emitClose({ code: 4100, reason: "first", wasClean: false });
    socket.emitMessage("late");
    socket.emitOpen();

    // harness が呼び出し順と server の index を保持することを確認します。
    expect(events).toEqual(["close:4100", "message:late", "open"]);
    expect(server.connection(0)).toBe(socket);
  });

  it("送信、close request、listener 解放を記録する", () => {
    // 制御可能な socket と観測可能な event listener を用意します。
    const server = new ControlledWebSocketServer();
    const socket = new server.WebSocket("wss://unipls.test") as unknown as ControlledWebSocket;
    const listener = () => {};

    // listener を登録・解除し、harness の件数を確認します。
    socket.addEventListener("message", listener);
    expect(socket.listenerCount("message")).toBe(1);
    socket.removeEventListener("message", listener);
    expect(socket.listenerCount("message")).toBe(0);

    // socket を開き、payload を1件送信して正常 close を要求します。
    socket.emitOpen();
    socket.send("query");
    socket.close(1000, "done");

    // transport の記録が payload と close 情報を保持することを確認します。
    expect(socket.sent).toEqual(["query"]);
    expect(socket.closeRequests).toEqual([{ code: 1000, reason: "done" }]);
  });
});
