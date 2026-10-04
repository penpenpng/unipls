import { describe, expect, it } from "vite-plus/test";

import type { UniplsLog } from "../../../src/index.ts";
import {
  UniplsSocket,
  UniplsSocketClosedError,
  UniplsSocketDroppedError,
} from "../../../src/socket.ts";
import { ControlledWebSocketServer } from "../../support/index.ts";

describe("低レベルsocketの公開契約", () => {
  it("変換失敗を同期ログへ渡し、sink の例外を隔離する", async () => {
    const transport = new ControlledWebSocketServer();
    const cause = new Error("decode failed");
    const logs: UniplsLog[] = [];
    const client = new UniplsSocket<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      deserializer(data) {
        if (data === "bad") {
          throw cause;
        }

        return String(data);
      },
      logSink(log) {
        logs.push(log);
        throw new Error("sink failed");
      },
    });
    const messages: string[] = [];

    client.on("message", ({ message }) => messages.push(message));
    const opening = client.open();
    const socket = transport.current;

    socket.emitOpen();
    await opening;

    expect(() => socket.emitMessage("bad")).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "warning",
      event: "message/deserialization",
      cause,
      context: { transportEpochId: client.transportEpochId, messageSequence: 1 },
    });
    expect(Object.isFrozen(logs[0])).toBe(true);
    expect(Object.isFrozen(logs[0]?.context)).toBe(true);
    socket.emitMessage("good");
    expect(messages).toEqual(["good"]);
    const closing = client.close();

    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * import { UniplsSocket } from "unipls/socket";
   * const socket = new UniplsSocket({ url, WebSocket, serializer, deserializer });
   * socket.on("message", ({ transportEpochId, message }) => consume(message));
   * await socket.open();
   * await socket.enqueue(query);
   * await socket.close();
   * // eventには内部transport objectではなく接続試行IDだけを公開する
   * ```
   */
  it("構造的WebSocketを注入して変換済みdataと有限eventを公開する", async () => {
    // wire dataを明示的に変換する低レベルclientとevent observerを用意します。
    const transport = new ControlledWebSocketServer();
    const opened: object[] = [];
    const messages: object[] = [];
    const closed: object[] = [];
    const client = new UniplsSocket<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      serializer: (message) => `wire:${message}`,
      deserializer: (data) => String(data).replace(/^wire:/u, ""),
    });

    client.on("open", (event) => opened.push(event));
    client.on("message", (event) => messages.push(event));
    client.on("closed", (event) => closed.push(event));
    const rejectUnknownEventAtCompileTime = () => {
      // @ts-expect-error 低レベルclientも存在しないevent名を受け付けません。
      client.on("unknown", () => {});
    };

    void rejectUnknownEventAtCompileTime;

    // ! 注入したWebSocketが接続を確立すると、同じ接続試行IDでopenを通知します。
    const opening = client.open();
    const connection = transport.current;

    connection.emitOpen();
    await opening;
    expect(opened).toEqual([{ transportEpochId: client.transportEpochId }]);

    // ! peerからwire messageが届くと変換後の値だけをmessage eventへ渡します。
    await client.enqueue("request");
    expect(connection.sent).toEqual(["wire:request"]);
    connection.emitMessage("wire:response");
    expect(messages).toEqual([{ transportEpochId: client.transportEpochId, message: "response" }]);

    // ! close handshakeの完了後に内部epochを含まないclosed eventを通知します。
    const closing = client.close();

    connection.emitClose();
    await closing;
    expect(closed).toEqual([
      {
        transportEpochId: client.transportEpochId,
        close: { code: 1000, reason: "", wasClean: true },
      },
    ]);
    expect([...opened, ...messages, ...closed].every((event) => Object.isFrozen(event))).toBe(true);
    expect([...opened, ...messages, ...closed].every((event) => !("epoch" in event))).toBe(true);
  });

  /**
   * ```ts
   * await socket.enqueue(payload); // 未接続なのでUniplsSocketClosedError
   * const opening = socket.open();
   * // ! 接続成立前にpeerが接続を閉じる
   * await opening; // UniplsSocketDroppedError
   * ```
   */
  it("未接続の送信をclosed error、接続中の切断をdropped errorにする", async () => {
    // まだopenしていない低レベルsocketでは送信を開始できません。
    const transport = new ControlledWebSocketServer();
    const client = new UniplsSocket<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });

    await expect(client.enqueue("message")).rejects.toBeInstanceOf(UniplsSocketClosedError);

    // ! 接続試行中にpeer closeが届くと、openはdropとして終了します。
    const opening = client.open();

    transport.current.emitClose({ code: 4100, wasClean: false });
    await expect(opening).rejects.toBeInstanceOf(UniplsSocketDroppedError);

    // 明示closeによってdrop後の接続資源も解放します。
    await client.close();
  });
});
