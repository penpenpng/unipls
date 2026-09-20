import { describe, expect, it, vi } from "vite-plus/test";

import {
  Unipls,
  UniplsBufferOverflowError,
  UniplsDroppedError,
  UniplsInvalidUsageError,
  UniplsOpenError,
  UniplsTimeoutError,
  type StreamFinalization,
  type SubscriptionHandle,
  type UniplsDiagnostic,
} from "../../src/index.ts";
import {
  ControlledWebSocketServer,
  flushMicrotasks,
  UniplsRaceScenario,
} from "../support/index.ts";

async function openClient(client: Unipls<string, string>, transport: ControlledWebSocketServer) {
  const opening = client.open();
  transport.current.emitOpen();
  await opening;
  return transport.current;
}

async function closeClient(client: Unipls<string, string>, socket: { emitClose(): void }) {
  const closing = client.close();
  socket.emitClose();
  await closing;
}

describe("stream operation の共通 lifecycle", () => {
  /**
   * ```ts
   * const subscription = client.listen({
   *   next: consume,
   * });
   * subscription.unsubscribe();
   * subscription.unsubscribe(); // 冪等
   * const finalization = await subscription.closed;
   * // finalization は frozen な { ok: true, reason: "unsubscribed" }
   * const stop = () => subscription.unsubscribe(); // framework に渡す明示的 adapter
   * ```
   */
  it("callback subscription を冪等に解除して frozen な終了結果を一度だけ返す", async () => {
    // callback delivery と終了後のメッセージを観測します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const messages: string[] = [];
    const subscription = client.listen({ next: (message) => messages.push(message) });

    // ! ready 接続から届くメッセージを callback へ同期配送します。
    socket.emitMessage("first");
    expect(messages).toEqual(["first"]);

    // unsubscribe の競合や繰り返しは同じ終了結果へ収束します。
    subscription.unsubscribe();
    subscription.unsubscribe();
    const firstFinalization = await subscription.closed;
    const secondFinalization = await subscription.closed;
    expect(firstFinalization).toBe(secondFinalization);
    expect(firstFinalization).toEqual({ ok: true, reason: "unsubscribed" });
    expect(Object.isFrozen(firstFinalization)).toBe(true);

    // 終了後のメッセージは callback へ届かず、暗黙の dispose protocol も公開しません。
    socket.emitMessage("late");
    expect(messages).toEqual(["first"]);
    expect(Symbol.dispose in subscription).toBe(false);
    expect(Symbol.asyncDispose in subscription).toBe(false);
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const continued = client.listen({ next: mayThrow });
   * const failed = client.listen({ next: mayThrow, callbackError: "unsubscribe" });
   * const independent = client.listen({ next: consume });
   * // ! mayThrow が同期的に例外を投げるメッセージが届く
   * await continued.closed; // 後続メッセージまで継続する
   * await failed.closed; // callback-error と元の例外で終了する
   * // independent への同じメッセージのfan-outは止まらない
   * ```
   */
  it("callback の同期例外を診断して policy と他 subscriber から隔離する", async () => {
    // 継続、終了、独立fan-outの3つのcallback streamを登録します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const cause = new Error("callback failed");
    const diagnostics: UniplsDiagnostic[] = [];
    const continuedMessages: string[] = [];
    const independentMessages: string[] = [];
    client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    const continued = client.listen({
      next: (message) => {
        if (message === "bad") throw cause;
        continuedMessages.push(message);
      },
    });
    const failed = client.listen({
      next: () => {
        throw cause;
      },
      callbackError: "unsubscribe",
    });
    const independent = client.listen({ next: (message) => independentMessages.push(message) });

    // ! 同じメッセージで2つのcallbackが失敗しても、最後のsubscriberまで配送します。
    socket.emitMessage("bad");
    const failedFinalization = await failed.closed;
    expect(failedFinalization).toEqual({ ok: false, reason: "callback-error", error: cause });
    expect(independentMessages).toEqual(["bad"]);

    // 既定policyのstreamは後続メッセージを引き続き観測します。
    socket.emitMessage("good");
    expect(continuedMessages).toEqual(["good"]);
    await flushMicrotasks();
    expect(
      diagnostics.map((diagnostic) =>
        diagnostic.type === "stream-callback-failed"
          ? {
              type: diagnostic.type,
              severity: diagnostic.severity,
              cause: diagnostic.cause,
              policy: diagnostic.policy,
            }
          : diagnostic.type,
      ),
    ).toEqual([
      { type: "stream-callback-failed", severity: "error", cause, policy: "continue" },
      { type: "stream-callback-failed", severity: "error", cause, policy: "unsubscribe" },
    ]);

    // 残ったstreamを終了します。
    continued.unsubscribe();
    independent.unsubscribe();
    await Promise.all([continued.closed, independent.closed]);
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * let subscription;
   * subscription = client.listen({
   *   callbackError: "unsubscribe",
   *   next() {
   *     subscription.unsubscribe();
   *     throw callbackError;
   *   },
   * });
   * // ! callbackを呼ぶメッセージが届く
   * // 先に実行された明示解除が勝ち、closedはunsubscribedとして一度だけ解決する
   * ```
   */
  it("callback 内の再入解除と例外を最初に確定した終了理由へ収束させる", async () => {
    // callbackから同じsubscriptionを解除した後に例外を投げるstreamを作ります。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const cause = new Error("callback failed after unsubscribe");
    const diagnostics: UniplsDiagnostic[] = [];
    client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    let subscription!: SubscriptionHandle<StreamFinalization<string>>;
    subscription = client.listen({
      callbackError: "unsubscribe",
      next: () => {
        subscription.unsubscribe();
        throw cause;
      },
    });

    // ! callbackの再入解除が先にsettle gateを通り、その後のcallback failureは診断だけになります。
    socket.emitMessage("message");
    await expect(subscription.closed).resolves.toEqual({ ok: true, reason: "unsubscribed" });
    await flushMicrotasks();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      type: "stream-callback-failed",
      cause,
      policy: "unsubscribe",
    });
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const calls = [];
   * const gate = deferred();
   * const subscription = client.listen({
   *   next: async (message) => {
   *     calls.push(message);
   *     await gate.promise;
   *   },
   * });
   * // ! gateの完了前に2件のメッセージが届く
   * // callbackは2回とも直ちに呼ばれ、戻り値のPromiseを待機・診断しない
   * ```
   */
  it("callback が返す Promise を待機せず配送を逐次化しない", async () => {
    // 未完了Promiseを返すcallbackと診断observerを用意します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const diagnostics: UniplsDiagnostic[] = [];
    const calls: string[] = [];
    const cause = new Error("async callback failed");
    const returnedPromises: Promise<void>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    const subscription = client.listen({
      next: (message) => {
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
    expect(diagnostics).toEqual([]);

    // 利用者側でrejectを処理しても、callbackの非同期失敗はlibraryの診断やlifecycleへ変換されません。
    const observedRejections = returnedPromises.map((returned) => returned.catch((error) => error));
    release();
    await expect(Promise.all(observedRejections)).resolves.toEqual([cause, cause]);
    expect(diagnostics).toEqual([]);
    subscription.unsubscribe();
    await subscription.closed;
    await closeClient(client, socket);
  });

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
  it("for await の break をunsubscribeへ写像して未処理bufferを破棄する", async () => {
    // 最初のメッセージでbreakするconsumerを開始します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
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
    await closeClient(client, socket);
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
  it("operation開始時からbufferするsingle-consumer AsyncSubscriptionを返す", async () => {
    // iterator取得前からメッセージを保持するstreamを開始します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const messages = client.listen({ buffer: 2 });
    socket.emitMessage("first");
    socket.emitMessage("second");

    // 最初のiteratorが開始前にbufferされたメッセージを順番どおり取得します。
    const iterator = messages[Symbol.asyncIterator]();
    expect(messages[Symbol.asyncIterator]).toBeTypeOf("function");
    expect(() => messages[Symbol.asyncIterator]()).toThrow(UniplsInvalidUsageError);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "second" });

    // iterator.return()はbufferを破棄してsubscriptionを正常終了します。
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(messages.closed).resolves.toEqual({ ok: true, reason: "unsubscribed" });
    await closeClient(client, socket);
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
  it("terminator を selector より先に評価してterminal messageをyieldしない", async () => {
    // selectorとterminatorの呼び出しを記録するAsyncSubscriptionを作ります。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
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
    await closeClient(client, socket);
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
  it("terminator failure のメッセージを破棄してpredicate policyを適用する", async () => {
    // 既定継続と明示失敗のstreamを用意します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const cause = new Error("terminator failed");
    const selectorCalls: string[] = [];
    const mayThrow = (message: string) => {
      if (message === "bad") throw cause;
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

    // 既定継続streamだけが後続メッセージを受け取ります。
    socket.emitMessage("good");
    await expect(continuedIterator.next()).resolves.toEqual({ done: false, value: "good" });
    expect(selectorCalls).toEqual(["good"]);
    continued.unsubscribe();
    await continued.closed;
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const continued = client.listen({ selector: mayThrow });
   * const failed = client.listen({ selector: mayThrow, predicateError: "fail" });
   * // ! selectorが例外を投げるメッセージが届く
   * // continuedは後続メッセージを待ち、failedだけ元の例外で終了する
   * ```
   */
  it("selector failure のメッセージを破棄してpredicate policyを適用する", async () => {
    // 既定継続と明示失敗のstreamへ同じselectorを設定します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const cause = new Error("selector failed");
    const mayThrow = (message: string) => {
      if (message === "bad") throw cause;
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

    // 既定継続streamは後続の一致メッセージを取得できます。
    socket.emitMessage("good");
    await expect(continuedIterator.next()).resolves.toEqual({ done: false, value: "good" });
    continued.unsubscribe();
    await continued.closed;
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const messages = client.listen({ buffer: 64 });
   * // ! consumerが取得しないまま64件届く
   * // capacityちょうどでは継続する
   * // ! 65件目が届く
   * // UniplsBufferOverflowErrorでiterationを失敗させ、closedは同じerrorを保持する
   * ```
   */
  it("既定capacity 64の境界を超えると重複診断なしでbuffer overflowになる", async () => {
    // 既定bufferと診断observerを用意します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const diagnostics: UniplsDiagnostic[] = [];
    client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
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
    expect(diagnostics).toEqual([]);
    await closeClient(client, socket);
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
  it("buffer capacityの0・負数・非整数・非有限値を同期的に拒否する", async () => {
    // validation後も正常に閉じられるactive sessionを作ります。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);

    // 数値shorthandとobject形式の両方で同じcapacity規則を適用します。
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => client.listen({ buffer: capacity })).toThrow(RangeError);
      expect(() => client.listen({ buffer: { capacity, overflow: "error" } })).toThrow(RangeError);
    }
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const latest = client.listen({ buffer: "latest" });
   * const oldest = client.listen({ buffer: { capacity: 2, overflow: "drop-oldest" } });
   * const newest = client.listen({ buffer: { capacity: 2, overflow: "drop-newest" } });
   * // ! 各bufferのcapacityを超えるメッセージが届く
   * // policyどおりのメッセージを保持し、破棄1件ごとにwarning diagnosticを通知する
   * ```
   */
  it("lossy buffer policyを適用して破棄ごとの診断を通知する", async () => {
    // 3種類のlossy policyをselectorで分離して同じ接続へ登録します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const diagnostics: UniplsDiagnostic[] = [];
    client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
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

    // 診断はmessage本体を含まず、正規化前のstrategyと実効capacityを示します。
    expect(
      diagnostics.map((diagnostic) =>
        diagnostic.type === "stream-message-dropped"
          ? {
              severity: diagnostic.severity,
              strategy: diagnostic.strategy,
              capacity: diagnostic.capacity,
              hasMessage: "message" in diagnostic,
            }
          : diagnostic.type,
      ),
    ).toEqual([
      { severity: "warning", strategy: "latest", capacity: 1, hasMessage: false },
      { severity: "warning", strategy: "drop-oldest", capacity: 2, hasMessage: false },
      { severity: "warning", strategy: "drop-newest", capacity: 2, hasMessage: false },
    ]);

    // 3つのstreamを正常終了します。
    latest.unsubscribe();
    oldest.unsubscribe();
    newest.unsubscribe();
    await Promise.all([latest.closed, oldest.closed, newest.closed]);
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const latest = client.listen({ buffer: "latest" });
   * // diagnostic listenerは登録しない
   * // ! buffer capacityを超えるメッセージが届く
   * // latestの保持値は更新するが、診断recordは生成しない
   * ```
   */
  it("診断listenerがないlossy bufferでは診断record生成を省略する", async () => {
    // 診断observerを持たないlatest streamを用意します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const messages = client.listen({ buffer: "latest" });
    const now = vi.spyOn(Date, "now");
    now.mockClear();

    // ! message loss時に診断時刻を取得せず、最新メッセージだけを保持します。
    socket.emitMessage("old");
    socket.emitMessage("latest");
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
    const iterator = messages[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "latest" });
    messages.unsubscribe();
    await messages.closed;
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const opening = client.open(provisioner);
   * const messages = client.listen({});
   * // ! 最初の接続のprovisioningが失敗し、sessionがreadyにならない
   * // opening、iteration、closedが同じUniplsOpenErrorを共有する
   * ```
   */
  it("initial openのterminal failureを同じopen errorでstreamへ通知する", async () => {
    // ready前にstreamを登録し、既知の原因でinitial provisioningを失敗させます。
    const scenario = new UniplsRaceScenario({ reconnectable: false });
    const cause = new Error("provisioning failed");
    const opening = scenario.beginOpen();
    const messages = scenario.client.listen({});
    const pending = messages[Symbol.asyncIterator]().next();
    scenario.transport.current.emitOpen();
    scenario.provisioner.fail(scenario.provisioner.invocations.take(), cause);

    // ! sessionのterminal outcomeがopen、iterator、closedへ同じerror objectを通知します。
    const openError = await opening.catch((error) => error as UniplsOpenError);
    expect(openError).toBeInstanceOf(UniplsOpenError);
    await expect(pending).rejects.toBe(openError);
    await expect(messages.closed).resolves.toEqual({
      ok: false,
      reason: "open-error",
      error: openError,
    });
  });

  /**
   * ```ts
   * const callbackStream = client.listen({ next: consume });
   * const iterableStream = client.listen({});
   * await client.close();
   * // 両方のclosedは { ok: true, reason: "closed" }
   * // pending iterator.next()もthrowせずdoneになる
   * ```
   */
  it("利用者のsession closeを全streamの正常終了にする", async () => {
    // callbackとAsyncIterableの両deliveryを同じsessionで開始します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const callbackStream = client.listen({ next: () => {} });
    const iterableStream = client.listen({});
    const pending = iterableStream[Symbol.asyncIterator]().next();

    // 明示closeはstreamの失敗ではなく正常なclosed finalizationです。
    const closing = client.close();
    await expect(callbackStream.closed).resolves.toEqual({ ok: true, reason: "closed" });
    await expect(iterableStream.closed).resolves.toEqual({ ok: true, reason: "closed" });
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const reason = { code: "stop" };
   * const subscription = client.listen({ signal });
   * controller.abort(reason);
   * const finalization = await subscription.closed;
   * await iterator.next();
   * // finalization.errorとiteratorのthrow値はreasonと同一
   * ```
   */
  it("abort reasonを包まずclosedとiteratorで同じ値を共有する", async () => {
    // pending iteratorを持つstreamを外部signalへ束縛します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const controller = new AbortController();
    const reason = { code: "stop" };
    const subscription = client.listen({ signal: controller.signal });
    const pending = subscription[Symbol.asyncIterator]().next();

    // abortがsettle gateを通るとcleanup後に両consumerへ同じreasonを通知します。
    controller.abort(reason);
    const finalization = await subscription.closed;
    expect(finalization).toEqual({ ok: false, reason: "aborted", error: reason });
    await expect(pending).rejects.toBe(reason);
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const subscription = client.listen({ retry: "wait" });
   * // ! ready接続がdropし、reconnectorがcancel、exhaust、setup失敗のいずれかに至る
   * const finalization = await subscription.closed;
   * await iterator.next();
   * // closedとiteratorがcanonicalな同じUniplsDroppedErrorを共有する
   * ```
   */
  it.each([
    { mode: "cancel" as const, outcome: "recovery-cancelled" as const },
    { mode: "exhaust" as const, outcome: "recovery-exhausted" as const },
    { mode: "setup-failure" as const, outcome: "reconnector-failed" as const },
  ])("recoveryの$modeでstreamを$outcomeへ一度だけ終了する", async ({ mode, outcome }) => {
    // dropをまたいで待機するstreamをready sessionへ登録します。
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    const subscription = scenario.client.listen({ retry: "wait" });
    const pending = subscription[Symbol.asyncIterator]().next();
    const cause = new Error(`recovery ${mode}`);
    if (mode === "setup-failure") scenario.reconnector.failNextSetup(cause);

    // ! 指定したrecovery terminal outcomeがsessionとstreamを一度だけ終了します。
    scenario.drop();
    const snapshot = scenario.client.lifecycle;
    if (mode !== "setup-failure" && snapshot.phase !== "recovering") {
      throw new Error("Expected recovery");
    }
    if (mode === "cancel") scenario.reconnector.invocations.take().cancel();
    if (mode === "exhaust") scenario.reconnector.invocations.take().exhaust(cause);
    const finalization = await subscription.closed;
    expect(finalization.ok).toBe(false);
    if (finalization.ok) throw new Error("Expected failure");
    expect(finalization.reason).toBe("dropped");
    expect(finalization.error).toBeInstanceOf(UniplsDroppedError);
    expect((finalization.error as UniplsDroppedError).outcome).toBe(outcome);
    if (snapshot.phase === "recovering") {
      expect((finalization.error as UniplsDroppedError).drop).toBe(snapshot.drop);
    }
    if (mode !== "cancel") {
      expect((finalization.error as UniplsDroppedError).cause).toBe(cause);
    }
    await expect(pending).rejects.toBe(finalization.error);
    subscription.unsubscribe();
    await expect(subscription.closed).resolves.toBe(finalization);
  });

  /**
   * ```ts
   * // ! clientがrecovery中で次の接続を待っている
   * const subscription = client.listen({ next: consume, timeout: 100 });
   * // provisioning中のmessageはconsumeへ届かない
   * // ! 代替接続がreadyになり、その後application messageが届く
   * // ready後だけconsumeへ届き、timeoutは最初の受付時から継続する
   * ```
   */
  it("recovery中に作ったlistenを次のreadyから開始してdeadlineを維持する", async () => {
    // 仮想時計でrecoveryからready後まで同じdeadlineを進めます。
    vi.useFakeTimers();
    try {
      const scenario = new UniplsRaceScenario();
      const opening = scenario.beginOpen();
      scenario.transport.current.emitOpen();
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await opening;
      scenario.drop();
      const recovery = scenario.reconnector.invocations.take();
      const received: string[] = [];
      const subscription = scenario.client.listen({
        next: (message) => received.push(message),
        timeout: 100,
      });

      // 90ms後の代替接続でもprovisioning messageは通常listenへ届きません。
      await vi.advanceTimersByTimeAsync(90);
      recovery.reconnect();
      const replacement = scenario.transport.current;
      replacement.emitOpen();
      replacement.emitMessage("provisioning");
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await scenario.waitForLifecycle(({ phase }) => phase === "open");
      replacement.emitMessage("application");
      expect(received).toEqual(["application"]);

      // readyから100msではなく、最初の受付から100msでtimeoutします。
      await vi.advanceTimersByTimeAsync(10);
      const finalization = await subscription.closed;
      expect(finalization.ok).toBe(false);
      if (finalization.ok) throw new Error("Expected failure");
      expect(finalization.reason).toBe("timeout");
      expect(finalization.error).toBeInstanceOf(UniplsTimeoutError);

      const closing = scenario.client.close();
      replacement.emitClose();
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ```ts
   * const subscription = client.subscribe({
   *   query: () => {
   *     throw factoryError;
   *   },
   *   selector,
   * });
   * // query factoryの失敗をfatal-errorとしてiterationとclosedへ同じ値で通知する
   * ```
   */
  it("subscribeのquery factory failureを同じfatal errorで終了する", async () => {
    // ready接続で、評価時に既知の例外を投げるquery factoryを指定します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const cause = new Error("query factory failed");
    const subscription = client.subscribe({
      query: () => {
        throw cause;
      },
      selector: () => true,
    });
    const iterator = subscription[Symbol.asyncIterator]();

    // factoryを呼ぶ初回送信が失敗し、remoteへ何も送らずstreamを終了します。
    const finalization = await subscription.closed;
    expect(finalization).toEqual({ ok: false, reason: "fatal-error", error: cause });
    await expect(iterator.next()).rejects.toBe(cause);
    expect(socket.sent).toEqual([]);
    await closeClient(client, socket);
  });

  /**
   * ```ts
   * const subscription = client.subscribe({
   *   query: factory,
   *   selector,
   *   retry: "resend",
   * });
   * // ! 初回送信後にdropし、代替接続がreadyになる
   * // factoryを再評価して再送し、代替接続のmessageをiterationできる
   * subscription.unsubscribe();
   * ```
   */
  it("subscribeを明示的なresend後も同じAsyncSubscriptionとして継続する", async () => {
    // query factoryの評価回数と各接続の送信値を観測します。
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    let factoryCalls = 0;
    const subscription = scenario.client.subscribe({
      query: () => `subscribe-${++factoryCalls}`,
      selector: (message) => message.startsWith("message"),
      retry: "resend",
    });
    await flushMicrotasks();
    expect(scenario.transport.current.sent).toEqual(["subscribe-1"]);

    // ! drop後の代替readyでfactoryを再評価して一度だけ再送します。
    scenario.drop();
    const recovery = scenario.reconnector.invocations.take();
    recovery.reconnect();
    const replacement = scenario.transport.current;
    replacement.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    await flushMicrotasks();
    expect(replacement.sent).toEqual(["subscribe-2"]);

    // 同じiteratorが回復後のメッセージを受け取り、明示解除で正常終了します。
    const iterator = subscription[Symbol.asyncIterator]();
    replacement.emitMessage("message-after-recovery");
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "message-after-recovery",
    });
    subscription.unsubscribe();
    await expect(subscription.closed).resolves.toEqual({ ok: true, reason: "unsubscribed" });
    await closeClient(scenario.client, replacement);
  });
});
