import { describe, expect, it } from "vite-plus/test";

import { Unipls } from "../../src/index.ts";
import { closeClient, ControlledWebSocketServer, openClient } from "../support/index.ts";

describe("高レベルoperationのmessage変換", () => {
  /**
   * ```ts
   * const client = new Unipls({
   *   serializer: encode,
   *   deserializer: decode,
   * });
   * await client.cast({ query: domainValue }); // encodeしたwire dataを送る
   * // ! decode可能なwire dataがWebSocketから届く
   * await client.next({ selector }); // decode後のdomain valueを受け取る
   * ```
   */
  it("送信前にserializeし、selectorへ渡す前にdeserializeする", async () => {
    // wire表現とdomain表現を区別する変換を指定します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<number, number>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      serializer: (value) => `wire:${value}`,
      deserializer: (data) => Number(String(data).replace(/^wire:/u, "")),
    });
    const socket = await openClient(client, transport);

    await client.cast({ query: 7 });
    expect(socket.sent).toEqual(["wire:7"]);
    const received = client.next({ selector: (value) => value === 42 });
    // ! peerからwire形式のmessageが届きます。
    socket.emitMessage("wire:42");
    await expect(received).resolves.toBe(42);

    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const client = new Unipls({ serializer: () => { throw cause; } });
   * await client.cast({ query }); // causeそのものでrejectする
   * await client.request({ query, selector }); // causeそのものでrejectする
   * await client.subscribe({ query, selector }).closed; // fatal-errorにcauseを保持する
   * ```
   */
  it("serializer failureを各送信operation固有のfatal resultにする", async () => {
    // 既知の値を投げるserializerを持つready clientを用意します。
    const transport = new ControlledWebSocketServer();
    const cause = new Error("serialization failed");
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      serializer: () => {
        throw cause;
      },
    });
    const socket = await openClient(client, transport);

    await expect(client.cast({ query: "cast" })).rejects.toBe(cause);
    await expect(client.request({ query: "request", selector: () => true })).rejects.toBe(cause);
    const subscription = client.subscribe({ query: "subscribe", selector: () => true });
    const finalization = await subscription.closed;
    expect(finalization).toEqual({ ok: false, reason: "fatal-error", error: cause });
    await expect(subscription[Symbol.asyncIterator]().next()).rejects.toBe(cause);
    expect(socket.sent).toEqual([]);

    await closeClient(client, socket);
  });
});
