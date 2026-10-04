import { describe, expect, it } from "vite-plus/test";

import { UniplsInvalidUsageError } from "../../../src/index.ts";
import { createReadyClient } from "../../support/index.ts";

describe("AsyncIterable stream", () => {
  /**
   * ```ts
   * const messages = client.listen({ buffer: 2 });
   * for await (const message of messages) {
   *   consume(message);
   *   break;
   * }
   * // breakがunsubscribeへ写像され、buffer済みの残りを破棄する
   * ```
   */
  it("for await の break を unsubscribe へ写像して未処理 buffer を破棄する", async () => {
    const { client, socket, close } = await createReadyClient();
    const messages = client.listen({ buffer: 2 });
    const consumed: string[] = [];
    const consuming = (async () => {
      for await (const message of messages) {
        consumed.push(message);
        break;
      }
    })();

    // ! 2件が続けて届いても、consumerは1件目だけを処理して購読を終了します。
    socket.emitMessage("first");
    socket.emitMessage("buffered");
    await consuming;
    expect(consumed).toEqual(["first"]);
    await expect(messages.closed).resolves.toEqual({ ok: true, reason: "unsubscribed" });
    await close();
  });

  /**
   * ```ts
   * const messages = client.listen({ buffer: 2 });
   * // ! iterator取得前に2件のメッセージが届く
   * const iterator = messages[Symbol.asyncIterator]();
   * await iterator.next(); // 1件目
   * await iterator.next(); // 2件目
   * messages[Symbol.asyncIterator](); // 2つ目なので同期的にUniplsInvalidUsageError
   * await iterator.return(); // unsubscribeへ写像する
   * ```
   */
  it("operation 開始時から buffer する single-consumer AsyncSubscription を返す", async () => {
    const { client, socket, close } = await createReadyClient();
    const messages = client.listen({ buffer: 2 });
    socket.emitMessage("first");
    socket.emitMessage("second");
    const iterator = messages[Symbol.asyncIterator]();
    expect(messages[Symbol.asyncIterator]).toBeTypeOf("function");
    expect(() => messages[Symbol.asyncIterator]()).toThrow(UniplsInvalidUsageError);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "second" });
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(messages.closed).resolves.toEqual({ ok: true, reason: "unsubscribed" });
    await close();
  });

  /**
   * ```ts
   * const messages = client.listen({
   *   selector,
   *   terminator,
   * });
   * // ! terminatorに一致するメッセージが届く
   * // selectorへ渡さずyieldもせず、closedのterminated.messageだけに保持する
   * ```
   */
  it("terminator を selector より先に評価して terminal message を yield しない", async () => {
    const { client, socket, close } = await createReadyClient();
    const selectorCalls: string[] = [];
    const messages = client.listen({
      selector: (message) => {
        selectorCalls.push(message);
        return true;
      },
      terminator: (message) => message === "stop",
    });
    const iterator = messages[Symbol.asyncIterator]();
    const pending = iterator.next();

    // ! terminal messageは終了結果だけに入り、pending next()は正常終了します。
    socket.emitMessage("stop");
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(messages.closed).resolves.toEqual({
      ok: true,
      reason: "terminated",
      message: "stop",
    });
    expect(selectorCalls).toEqual([]);
    await close();
  });

  /**
   * ```ts
   * const continued = client.listen({ terminator: mayThrow });
   * const failed = client.listen({ terminator: mayThrow, predicateError: "fail" });
   * // ! terminatorが例外を投げるメッセージが届く
   * // どちらも同じメッセージをselectorやyieldへ渡さない
   * // continuedは後続メッセージを待ち、failedだけ元の例外で終了する
   * ```
   */
  it("terminator failure のメッセージを破棄して predicate policy を適用する", async () => {
    const { client, socket, close } = await createReadyClient();
    const cause = new Error("terminator failed");
    const selectorCalls: string[] = [];
    const mayThrow = (message: string) => {
      if (message === "bad") {
        throw cause;
      }
      return false;
    };
    const continued = client.listen({
      selector: (message) => {
        selectorCalls.push(message);
        return true;
      },
      terminator: mayThrow,
    });
    const failed = client.listen({ terminator: mayThrow, predicateError: "fail" });
    const continuedIterator = continued[Symbol.asyncIterator]();
    const failedIterator = failed[Symbol.asyncIterator]();

    // ! 失敗したterminatorの入力は両方の通常selectorとiteratorから破棄されます。
    socket.emitMessage("bad");
    const failedFinalization = await failed.closed;
    expect(failedFinalization).toEqual({ ok: false, reason: "fatal-error", error: cause });
    await expect(failedIterator.next()).rejects.toBe(cause);
    expect(selectorCalls).toEqual([]);
    socket.emitMessage("good");
    await expect(continuedIterator.next()).resolves.toEqual({ done: false, value: "good" });
    expect(selectorCalls).toEqual(["good"]);
    continued.unsubscribe();
    await continued.closed;
    await close();
  });

  /**
   * ```ts
   * const continued = client.listen({ selector: mayThrow });
   * const failed = client.listen({ selector: mayThrow, predicateError: "fail" });
   * // ! selectorが例外を投げるメッセージが届く
   * // continuedは後続メッセージを待ち、failedだけ元の例外で終了する
   * ```
   */
  it("selector failure のメッセージを破棄して predicate policy を適用する", async () => {
    const { client, socket, close } = await createReadyClient();
    const cause = new Error("selector failed");
    const mayThrow = (message: string) => {
      if (message === "bad") {
        throw cause;
      }
      return true;
    };
    const continued = client.listen({ selector: mayThrow });
    const failed = client.listen({ selector: mayThrow, predicateError: "fail" });
    const continuedIterator = continued[Symbol.asyncIterator]();
    const failedIterator = failed[Symbol.asyncIterator]();

    // ! 失敗したselectorの入力をyieldせず、明示failのstreamだけを終了します。
    socket.emitMessage("bad");
    const failedFinalization = await failed.closed;
    expect(failedFinalization).toEqual({ ok: false, reason: "fatal-error", error: cause });
    await expect(failedIterator.next()).rejects.toBe(cause);
    socket.emitMessage("good");
    await expect(continuedIterator.next()).resolves.toEqual({ done: false, value: "good" });
    continued.unsubscribe();
    await continued.closed;
    await close();
  });
});
