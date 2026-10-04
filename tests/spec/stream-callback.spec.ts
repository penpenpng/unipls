import { describe, expect, it } from "vite-plus/test";

import { type StreamFinalization, type SubscriptionHandle } from "../../src/index.ts";
import { createReadyClient, flushMicrotasks } from "../support/index.ts";

describe("callback stream", () => {
  /**
   * ```ts
   * const subscription = client.listen({
   *   onMessage: consume,
   * });
   * subscription.unsubscribe();
   * subscription.unsubscribe(); // 冪等
   * const finalization = await subscription.closed;
   * // finalization は frozen な { ok: true, reason: "unsubscribed" }
   * const stop = () => subscription.unsubscribe(); // framework に渡す明示的 adapter
   * ```
   */
  it("callback subscription を冪等に解除して frozen な終了結果を一度だけ返す", async () => {
    const { client, socket, close } = await createReadyClient();
    const messages: string[] = [];
    const subscription = client.listen({ onMessage: (message) => messages.push(message) });

    // ! ready 接続から届くメッセージを callback へ同期配送します。
    socket.emitMessage("first");
    expect(messages).toEqual(["first"]);
    subscription.unsubscribe();
    subscription.unsubscribe();
    const firstFinalization = await subscription.closed;
    const secondFinalization = await subscription.closed;
    expect(firstFinalization).toBe(secondFinalization);
    expect(firstFinalization).toEqual({ ok: true, reason: "unsubscribed" });
    expect(Object.isFrozen(firstFinalization)).toBe(true);
    socket.emitMessage("late");
    expect(messages).toEqual(["first"]);
    const disposalSymbols = Symbol as typeof Symbol & {
      readonly dispose?: symbol;
      readonly asyncDispose?: symbol;
    };
    if (disposalSymbols.dispose) expect(disposalSymbols.dispose in subscription).toBe(false);
    if (disposalSymbols.asyncDispose) {
      expect(disposalSymbols.asyncDispose in subscription).toBe(false);
    }
    await close();
  });

  /**
   * ```ts
   * const continued = client.listen({ onMessage: mayThrow });
   * const failed = client.listen({ onMessage: mayThrow, callbackError: "unsubscribe" });
   * const independent = client.listen({ onMessage: consume });
   * // ! mayThrow が同期的に例外を投げるメッセージが届く
   * await continued.closed; // 後続メッセージまで継続する
   * await failed.closed; // callback-error と元の例外で終了する
   * // independent への同じメッセージのfan-outは止まらない
   * ```
   */
  it("callback の同期例外を診断して policy と他 subscriber から隔離する", async () => {
    const { client, socket, close, logs } = await createReadyClient();
    const cause = new Error("callback failed");
    const continuedMessages: string[] = [];
    const independentMessages: string[] = [];
    const continued = client.listen({
      onMessage: (message) => {
        if (message === "bad") throw cause;
        continuedMessages.push(message);
      },
    });
    const failed = client.listen({
      onMessage: () => {
        throw cause;
      },
      callbackError: "unsubscribe",
    });
    const independent = client.listen({
      onMessage: (message) => independentMessages.push(message),
    });

    // ! 同じメッセージで2つのcallbackが失敗しても、最後のsubscriberまで配送します。
    socket.emitMessage("bad");
    const failedFinalization = await failed.closed;
    expect(failedFinalization).toEqual({ ok: false, reason: "callback-error", error: cause });
    expect(independentMessages).toEqual(["bad"]);
    socket.emitMessage("good");
    expect(continuedMessages).toEqual(["good"]);
    await flushMicrotasks();
    expect(
      logs.map((log) => ({
        event: log.event,
        level: log.level,
        cause: log.cause,
        policy: log.context?.policy,
      })),
    ).toEqual([
      { event: "operation/message-handler", level: "warning", cause, policy: "continue" },
      { event: "operation/message-handler", level: "error", cause, policy: "unsubscribe" },
    ]);
    expect(logs.every((log) => Object.isFrozen(log) && Object.isFrozen(log.context))).toBe(true);
    continued.unsubscribe();
    independent.unsubscribe();
    await Promise.all([continued.closed, independent.closed]);
    await close();
  });

  /**
   * ```ts
   * let subscription;
   * subscription = client.listen({
   *   callbackError: "unsubscribe",
   *   onMessage() {
   *     subscription.unsubscribe();
   *     throw callbackError;
   *   },
   * });
   * // ! callbackを呼ぶメッセージが届く
   * // 先に実行された明示解除が勝ち、closedはunsubscribedとして一度だけ解決する
   * ```
   */
  it("callback 内の再入解除と例外を最初に確定した終了理由へ収束させる", async () => {
    const { client, socket, close, logs } = await createReadyClient();
    const cause = new Error("callback failed after unsubscribe");
    let subscription!: SubscriptionHandle<StreamFinalization<string>>;
    subscription = client.listen({
      callbackError: "unsubscribe",
      onMessage: () => {
        subscription.unsubscribe();
        throw cause;
      },
    });

    // ! callbackの再入解除が先にsettle gateを通り、その後のcallback failureは診断だけになります。
    socket.emitMessage("message");
    await expect(subscription.closed).resolves.toEqual({ ok: true, reason: "unsubscribed" });
    await flushMicrotasks();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "operation/message-handler",
      level: "error",
      cause,
      context: { policy: "unsubscribe" },
    });
    await close();
  });

  /**
   * ```ts
   * const calls = [];
   * const gate = deferred();
   * const subscription = client.listen({
   *   onMessage: async (message) => {
   *     calls.push(message);
   *     await gate.promise;
   *   },
   * });
   * // ! gateの完了前に2件のメッセージが届く
   * // callbackは2回とも直ちに呼ばれ、戻り値のPromiseを待機・診断しない
   * ```
   */
  it("callback が返す Promise を待機せず配送を逐次化しない", async () => {
    const { client, socket, close, logs } = await createReadyClient();
    const calls: string[] = [];
    const cause = new Error("async callback failed");
    const returnedPromises: Promise<void>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subscription = client.listen({
      onMessage: (message) => {
        calls.push(message);
        const returned = gate.then(() => {
          throw cause;
        });
        returnedPromises.push(returned);
        return returned;
      },
    });

    // ! callbackの最初のPromiseが未完了でも、次のメッセージを直ちに配送します。
    socket.emitMessage("first");
    socket.emitMessage("second");
    expect(calls).toEqual(["first", "second"]);
    expect(logs).toEqual([]);
    const observedRejections = returnedPromises.map((returned) => returned.catch((error) => error));
    release();
    await expect(Promise.all(observedRejections)).resolves.toEqual([cause, cause]);
    expect(logs).toEqual([]);
    subscription.unsubscribe();
    await subscription.closed;
    await close();
  });
});
