import { describe, expect, it } from "vite-plus/test";

import { Unipls, type UniplsLog, type UniplsDrop } from "../../../src/index.ts";
import {
  ControlledReconnector,
  ControlledWebSocketServer,
  flushMicrotasks,
} from "../../support/index.ts";

describe("drop detector の lifecycle", () => {
  /**
   * ```ts
   * const detector = {
   *   setup(ctx) {
   *     ctx.defer(disposeFirst, { name: "first" });
   *     ctx.defer(disposeSecond, { name: "second" });
   *     return disposeThird;
   *   },
   * };
   * await client.open();
   * // ! detector が接続の drop を報告する
   * // 全disposerをLIFO順に一度ずつ試行してからreconnectorを開始する
   * ```
   */
  it("非同期cleanupと個別の失敗を完了してからdrop recoveryへ進む", async () => {
    // cleanupの途中を保留し、reconnector開始と各logの順序を観測します。
    const transport = new ControlledWebSocketServer();
    const reconnector = new ControlledReconnector();
    const secondFailure = new Error("second cleanup failed");
    const thirdFailure = new Error("third cleanup failed");
    const order: string[] = [];
    const diagnostics: UniplsLog[] = [];
    const drops: UniplsDrop[] = [];
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      reconnector,
      logSink: (log) => diagnostics.push(log),
      dropDetectors: [
        {
          name: "cleanup-probe",
          setup(ctx) {
            ctx.defer(
              () => {
                order.push("first");
              },
              { name: "first" },
            );
            ctx.defer(
              async () => {
                order.push("second:start");
                await secondGate;
                order.push("second:end");
                throw secondFailure;
              },
              { name: "second" },
            );

            return () => {
              order.push("third");
              throw thirdFailure;
            };
          },
        },
      ],
    });

    client.on("dropped", ({ drop }) => drops.push(drop));
    const opening = client.open({ setupConnection() {} });

    transport.current.emitOpen();
    await opening;

    // ! 利用者がdropを報告すると、同期disposerの後で非同期disposerを待機します。
    client.drop();
    expect(order).toEqual(["third", "second:start"]);
    expect(reconnector.invocations.size).toBe(0);
    expect(drops).toHaveLength(0);

    // 非同期disposerの失敗後も残りを実行し、本来のdropを回復判断へ渡します。
    releaseSecond();
    await flushMicrotasks();
    expect(order).toEqual(["third", "second:start", "second:end", "first"]);
    expect(drops).toHaveLength(1);
    const recovery = reconnector.invocations.take();

    expect(recovery.context.cause).toBe(drops[0]);
    expect(
      diagnostics.map((log) => ({
        event: log.event,
        cause: log.cause,
        name: log.context?.resourceName,
        source: log.context?.resourceSource,
      })),
    ).toEqual([
      { event: "resource/cleanup", cause: thirdFailure, name: undefined, source: "setup-return" },
      { event: "resource/cleanup", cause: secondFailure, name: "second", source: "defer" },
    ]);

    recovery.cancel();
  });

  /**
   * ```ts
   * const detector = { setup: () => disposeDetector };
   * await client.open();
   * // ! dropによる非同期cleanup中に利用者がclose()し、その後socket closeも届く
   * await client.close();
   * // 競合する終了経路が同じdisposeへ収束し、disposeDetectorは一度だけ実行される
   * ```
   */
  it("dropとcloseと後発socket closeが競合してもdetectorを一度だけ解放する", async () => {
    // detector cleanupを保留し、3つの終了経路を同じscopeへ競合させます。
    const transport = new ControlledWebSocketServer();
    const reconnector = new ControlledReconnector();
    const cleanupFailure = new Error("detector cleanup failed");
    const diagnostics: UniplsLog[] = [];
    let cleanupCount = 0;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const client = new Unipls({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      reconnector,
      logSink: (log) => diagnostics.push(log),
      dropDetectors: [
        {
          setup() {
            return async () => {
              cleanupCount += 1;

              await cleanupGate;
              throw cleanupFailure;
            };
          },
        },
      ],
    });
    const opening = client.open({ setupConnection() {} });
    const socket = transport.current;

    socket.emitOpen();
    await opening;

    // ! dropがcleanupを開始した直後にcloseを開始し、socketのclose eventも発生させます。
    client.drop();
    const closing = client.close();

    socket.emitClose();
    expect(cleanupCount).toBe(1);
    expect(reconnector.invocations.size).toBe(0);

    releaseCleanup();
    await closing;
    await flushMicrotasks();
    expect(cleanupCount).toBe(1);
    expect(client.lifecycle).toMatchObject({ phase: "closed", reason: "user" });
    expect(reconnector.invocations.size).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      event: "resource/cleanup",
      level: "error",
      cause: cleanupFailure,
      context: { resourceSource: "setup-return" },
    });
  });
});
