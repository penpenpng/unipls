import { describe, expect, it, vi } from "vite-plus/test";

import { UniplsBufferOverflowError } from "../../../src/index.ts";
import { createReadyClient, flushMicrotasks } from "../../support/index.ts";

describe("stream buffer", () => {
  /**
   * ```ts
   * const messages = client.listen({ buffer: 64 });
   * // ! consumerが取得しないまま64件届く
   * // capacityちょうどでは継続する
   * // ! 65件目が届く
   * // UniplsBufferOverflowErrorでiterationを失敗させ、closedは同じerrorを保持する
   * ```
   */
  it("既定 capacity 64 の境界を超えると重複診断なしで buffer overflow になる", async () => {
    const { client, socket, close, logs } = await createReadyClient();
    const messages = client.listen({});
    let settled = false;
    void messages.closed.then(() => {
      settled = true;
    });

    // ! 64件までは未処理メッセージを保持してstreamを継続します。
    for (let index = 0; index < 64; index += 1) socket.emitMessage(`message-${index}`);
    await flushMicrotasks();
    expect(settled).toBe(false);

    // ! 65件目でoverflowとなり、iteratorとclosedが同じerrorを共有します。
    socket.emitMessage("overflow");
    const finalization = await messages.closed;
    expect(finalization.ok).toBe(false);
    if (finalization.ok) throw new Error("Expected failure");
    expect(finalization.reason).toBe("buffer-overflow");
    expect(finalization.error).toBeInstanceOf(UniplsBufferOverflowError);
    const iterator = messages[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(finalization.error);
    expect(logs).toEqual([]);
    await close();
  });

  /**
   * ```ts
   * client.listen({ buffer: 0 });
   * client.listen({ buffer: -1 });
   * client.listen({ buffer: Number.NaN });
   * client.listen({ buffer: Number.POSITIVE_INFINITY });
   * // いずれもoperation登録前に同期的なRangeError
   * ```
   */
  it("buffer capacity の0・負数・非整数・非有限値を同期的に拒否する", async () => {
    const { client, close } = await createReadyClient();
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => client.listen({ buffer: capacity })).toThrow(RangeError);
      expect(() => client.listen({ buffer: { capacity, overflow: "error" } })).toThrow(RangeError);
    }
    await close();
  });

  /**
   * ```ts
   * const latest = client.listen({ buffer: "latest" });
   * const oldest = client.listen({ buffer: { capacity: 2, overflow: "drop-oldest" } });
   * const newest = client.listen({ buffer: { capacity: 2, overflow: "drop-newest" } });
   * // ! 各bufferのcapacityを超えるメッセージが届く
   * // policyどおりのメッセージを保持し、破棄1件ごとにwarningログを通知する
   * ```
   */
  it("lossy buffer policy を適用して破棄ごとの診断を通知する", async () => {
    const { client, socket, close, logs } = await createReadyClient();
    const latest = client.listen({
      selector: (message) => message.startsWith("L"),
      buffer: "latest",
    });
    const oldest = client.listen({
      selector: (message) => message.startsWith("O"),
      buffer: { capacity: 2, overflow: "drop-oldest" },
    });
    const newest = client.listen({
      selector: (message) => message.startsWith("N"),
      buffer: { capacity: 2, overflow: "drop-newest" },
    });

    // ! capacity超過時に各policyが異なるメッセージを保持します。
    for (const message of ["L1", "L2", "O1", "O2", "O3", "N1", "N2", "N3"]) {
      socket.emitMessage(message);
    }
    await flushMicrotasks();
    const latestIterator = latest[Symbol.asyncIterator]();
    const oldestIterator = oldest[Symbol.asyncIterator]();
    const newestIterator = newest[Symbol.asyncIterator]();
    await expect(latestIterator.next()).resolves.toEqual({ done: false, value: "L2" });
    await expect(oldestIterator.next()).resolves.toEqual({ done: false, value: "O2" });
    await expect(oldestIterator.next()).resolves.toEqual({ done: false, value: "O3" });
    await expect(newestIterator.next()).resolves.toEqual({ done: false, value: "N1" });
    await expect(newestIterator.next()).resolves.toEqual({ done: false, value: "N2" });
    expect(
      logs.map((log) => ({
        level: log.level,
        event: log.event,
        strategy: log.context?.strategy,
        capacity: log.context?.capacity,
      })),
    ).toEqual([
      { level: "warning", event: "message/overflow", strategy: "latest", capacity: 1 },
      { level: "warning", event: "message/overflow", strategy: "drop-oldest", capacity: 2 },
      { level: "warning", event: "message/overflow", strategy: "drop-newest", capacity: 2 },
    ]);
    expect(logs.every((log) => Object.isFrozen(log) && Object.isFrozen(log.context))).toBe(true);
    latest.unsubscribe();
    oldest.unsubscribe();
    newest.unsubscribe();
    await Promise.all([latest.closed, oldest.closed, newest.closed]);
    await close();
  });

  /**
   * ```ts
   * const latest = client.listen({ buffer: "latest" });
   * // logSinkは時刻を必要としない
   * // ! buffer capacityを超えるメッセージが届く
   * // latestの保持値は更新され、ログに時刻は含まれない
   * ```
   */
  it("lossy buffer のログに時刻を含めない", async () => {
    const { client, socket, close, logs } = await createReadyClient();
    const messages = client.listen({ buffer: "latest" });
    const now = vi.spyOn(Date, "now");
    now.mockClear();

    // ! message loss時に診断時刻を取得せず、最新メッセージだけを保持します。
    socket.emitMessage("old");
    socket.emitMessage("latest");
    expect(now).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect("occurredAt" in logs[0]!).toBe(false);
    now.mockRestore();
    const iterator = messages[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "latest" });
    messages.unsubscribe();
    await messages.closed;
    await close();
  });
});
