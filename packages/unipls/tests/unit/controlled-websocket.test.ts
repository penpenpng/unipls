import { describe, expect, it } from "vite-plus/test";

import { ControlledWebSocket, ControlledWebSocketServer } from "../support/index.ts";

describe("ControlledWebSocketServer", () => {
  it("emits transport events in caller-controlled order, including stale events", () => {
    const server = new ControlledWebSocketServer();
    const socket = new server.WebSocket("wss://unipls.test") as unknown as ControlledWebSocket;
    const events: string[] = [];

    socket.onclose = (event) => events.push(`close:${event.code}`);
    socket.onmessage = (event) => events.push(`message:${event.data}`);
    socket.onopen = () => events.push("open");

    socket.emitClose({ code: 4100, reason: "first", wasClean: false });
    socket.emitMessage("late");
    socket.emitOpen();

    expect(events).toEqual(["close:4100", "message:late", "open"]);
    expect(server.connection(0)).toBe(socket);
  });

  it("records sends, close requests, and listener release", () => {
    const server = new ControlledWebSocketServer();
    const socket = new server.WebSocket("wss://unipls.test") as unknown as ControlledWebSocket;
    const listener = () => {};

    socket.addEventListener("message", listener);
    expect(socket.listenerCount("message")).toBe(1);
    socket.removeEventListener("message", listener);
    expect(socket.listenerCount("message")).toBe(0);

    socket.emitOpen();
    socket.send("query");
    socket.close(1000, "done");

    expect(socket.sent).toEqual(["query"]);
    expect(socket.closeRequests).toEqual([{ code: 1000, reason: "done" }]);
  });
});
