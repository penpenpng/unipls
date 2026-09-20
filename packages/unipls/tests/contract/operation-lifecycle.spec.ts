import { describe, expect, it, vi } from "vite-plus/test";

import {
  Unipls,
  UniplsClosedError,
  UniplsInvalidUsageError,
  UniplsTimeoutError,
  type UniplsDiagnostic,
} from "../../src/index.ts";
import {
  ControlledProvisioner,
  ControlledWebSocketServer,
  flushMicrotasks,
  UniplsRaceScenario,
} from "../support/index.ts";

describe("operation の共通 lifecycle", () => {
  /**
   * ```ts
   * client.next({ selector }); // open() 前なので同期的に UniplsInvalidUsageError
   * await client.open();
   * await client.close();
   * client.cast({ query }); // close() 後なので同期的に UniplsInvalidUsageError
   * ```
   */
  it("5種類の operation を open intent の外では同期的に拒否する", async () => {
    // まだ論理セッションを開始していない client を作ります。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const operations = () => [
      () => client.cast({ query: "cast" }),
      () => client.next({ selector: () => true }),
      () => client.request({ query: "request", selector: () => true }),
      () => client.listen({}),
      () => client.subscribe({ query: "subscribe", selector: () => true }),
    ];

    // open() 前は、Promise や解除関数を返さず同じ domain error をその場で投げます。
    for (const operation of operations()) {
      expect(operation).toThrow(UniplsInvalidUsageError);
    }

    // セッションを ready にしてから明示的に閉じます。
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const closing = client.close();
    socket.emitClose();
    await closing;

    // close() 後も open intent 外なので、5種類すべてを同期的に拒否します。
    for (const operation of operations()) {
      expect(operation).toThrow(UniplsInvalidUsageError);
    }
  });

  /**
   * ```ts
   * await client.open();
   * const waiting = client.next({ selector }); // active session に受け付けられる
   * const closing = client.close();
   * await waiting; // close() 後に UniplsClosedError で非同期に reject する
   * await closing;
   * ```
   */
  it("受付後の close を同期エラーではなく operation の非同期結果にする", async () => {
    // ready なセッションで、完了していない operation を開始します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const waiting = client.next({ selector: () => false });

    // 利用者がセッションを閉じると、受付済み Promise だけが終了します。
    const closing = client.close();
    await expect(waiting).rejects.toBeInstanceOf(UniplsClosedError);
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * await client.open();
   * client.request({ query, selector, timeout: 0 }); // 同期的に RangeError
   * client.listen({ timeout: Number.NaN }); // 同期的に RangeError
   * ```
   */
  it("有限の正数ではない timeout を operation 登録前に同期的に拒否する", async () => {
    // timeout を検証できる active session を用意します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;

    // operation の種類によらず、不正値は待機を開始せず同じ数値範囲エラーになります。
    const operations = [
      () => client.cast({ query: "cast", timeout: 0 }),
      () => client.next({ selector: () => true, timeout: -1 }),
      () => client.request({ query: "request", selector: () => true, timeout: Number.NaN }),
      () => client.listen({ timeout: Number.POSITIVE_INFINITY }),
      () =>
        client.subscribe({
          query: "subscribe",
          selector: () => true,
          timeout: Number.NEGATIVE_INFINITY,
        }),
    ];
    for (const operation of operations) expect(operation).toThrow(RangeError);

    // 不正な呼び出しが残した資源なしでセッションを終了します。
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const opening = client.open(async (ctx) => {
   *   ctx.listen({ selector: isChallenge, onMessage: consumeChallenge });
   *   await authenticate();
   * });
   * const applicationMessage = client.next({ selector: isApplicationMessage });
   * // ! authenticate() の完了前に challenge が WebSocket から届く
   * // consumeChallenge だけが challenge を観測し、applicationMessage の selector は呼ばれない
   * await opening;
   * // ! ready 遷移後に application message が WebSocket から届く
   * await applicationMessage; // ready 後の message だけで解決する
   * ```
   */
  it("provisioning 用と通常 operation の受信経路を ready 境界で分離する", async () => {
    // provisioner を任意の時点で完了できるようにし、両側の観測回数を記録します。
    const transport = new ControlledWebSocketServer();
    let finishProvisioning!: () => void;
    const provisioningGate = new Promise<void>((resolve) => {
      finishProvisioning = resolve;
    });
    const provisioningMessages: string[] = [];
    let applicationSelectorCalls = 0;
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const opening = client.open(async (context) => {
      context.listen({
        selector: () => true,
        onMessage: (message) => provisioningMessages.push(message),
      });
      await provisioningGate;
    });
    const applicationMessage = client.next({
      selector: (message) => {
        applicationSelectorCalls += 1;
        return message === "application";
      },
    });

    // ! WebSocket が開きますが、provisioner はまだ完了していません。
    const socket = transport.current;
    socket.emitOpen();
    socket.emitMessage("challenge");
    expect(provisioningMessages).toEqual(["challenge"]);
    expect(applicationSelectorCalls).toBe(0);

    // provisioning を完了し、ready 後の message の配送先を確認します。
    finishProvisioning();
    await opening;
    socket.emitMessage("application");
    await expect(applicationMessage).resolves.toBe("application");
    expect(provisioningMessages).toEqual(["challenge"]);
    expect(applicationSelectorCalls).toBe(1);

    // セッションを終了します。
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const first = client.next({ selector: isPong });
   * const second = client.next({ selector: isPong });
   * // ! 1件の pong が WebSocket から届く
   * await Promise.all([first, second]); // 両方が同じ pong で解決する
   * ```
   */
  it("1件の message を一致する複数の operation へ broadcast する", async () => {
    // ready なセッションへ同じ selector を持つ operation を2件登録します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const first = client.next({ selector: (message) => message === "pong" });
    const second = client.next({ selector: (message) => message === "pong" });

    // ! WebSocket から届く1件を、dispatcher が登録時点の候補すべてへ配送します。
    socket.emitMessage("pong");
    await expect(Promise.all([first, second])).resolves.toEqual(["pong", "pong"]);

    // セッションを終了します。
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const continued = client.next({ selector: mayThrow });
   * const failed = client.next({ selector: mayThrow, predicateError: "fail" });
   * const independent = client.next({ selector: () => true });
   * // ! mayThrow が例外を投げる message が届く
   * await failed; // 元の例外で reject する
   * await independent; // 同じ message の fan-out は継続する
   * // ! 後続の一致 message が届く
   * await continued; // 既定 policy では後続 message を待ち続ける
   * ```
   */
  it("predicate failure を該当 operation に隔離して policy と診断を適用する", async () => {
    // 既定継続、明示失敗、独立した operation と診断 observer を用意します。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const diagnostics: UniplsDiagnostic[] = [];
    client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const cause = new Error("predicate failed");
    const mayThrow = (message: string) => {
      if (message === "bad") throw cause;
      return message === "good";
    };
    const continued = client.next({ selector: mayThrow });
    const failed = client.next({ selector: mayThrow, predicateError: "fail" });
    const independent = client.next({ selector: (message) => message === "bad" });

    // ! 最初の message では2件の predicate が失敗しても、3件目まで配送が続きます。
    socket.emitMessage("bad");
    await expect(failed).rejects.toBe(cause);
    await expect(independent).resolves.toBe("bad");

    // ! 次の message で、既定 policy の operation が正常に解決します。
    socket.emitMessage("good");
    await expect(continued).resolves.toBe("good");
    await flushMicrotasks();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
      "message-predicate-failed",
      "message-predicate-failed",
    ]);
    expect(diagnostics.map((diagnostic) => diagnostic.cause)).toEqual([cause, cause]);

    // セッションを終了します。
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const response = client.next({ selector: isValidMessage });
   * // ! deserializer が最初の raw message で例外を投げる
   * // connection-scoped diagnostic が通知され、response は終了しない
   * // ! 次の raw message は正常に変換できる
   * await response; // 正常な後続 message で解決する
   * ```
   */
  it("deserializer failure の message だけを破棄して後続 message を処理する", async () => {
    // 特定の入力だけ変換に失敗する client と診断 observer を作ります。
    const transport = new ControlledWebSocketServer();
    const cause = new Error("deserialization failed");
    const diagnostics: UniplsDiagnostic[] = [];
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      deserializer: (data) => {
        if (data === "bad") throw cause;
        return String(data);
      },
    });
    client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const response = client.next({ selector: (message) => message === "good" });

    // ! 変換不能な message の後にも、同じ operation は登録されたままです。
    socket.emitMessage("bad");
    socket.emitMessage("good");
    await expect(response).resolves.toBe("good");
    await flushMicrotasks();

    // 診断には raw payload ではなく、接続内 sequence と安全な入力 metadata だけを保持します。
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      type: "message-deserialization-failed",
      severity: "warning",
      cause,
      scope: { type: "connection", messageSequence: 1 },
      input: { kind: "text", size: 3 },
    });
    expect(Object.isFrozen(diagnostics[0])).toBe(true);
    expect(Object.isFrozen(diagnostics[0]?.scope)).toBe(true);

    // セッションを終了します。
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const factoryCause = new Error("factory");
   * await client.request({
   *   query: () => { throw factoryCause; },
   *   selector,
   * }); // factoryCause そのもので reject する
   * const serializerCause = new Error("serializer");
   * await client.cast({ query }); // serializerCause そのもので reject する
   * ```
   */
  it("message factory と serializer が投げた元の cause を operation 結果に保つ", async () => {
    // serializer の失敗を切り替えられる ready な client を用意します。
    const transport = new ControlledWebSocketServer();
    let serializerCause: unknown;
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      serializer: (message) => {
        if (serializerCause !== undefined) throw serializerCause;
        return message;
      },
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;

    // factory の同期例外は公開メソッドから漏れず、返された Promise の失敗値になります。
    const factoryCause = new Error("factory failed");
    const requested = client.request({
      query: () => {
        throw factoryCause;
      },
      selector: () => true,
    });
    await expect(requested).rejects.toBe(factoryCause);

    // serializer の同期例外も wrapper に置換せず、同じ object identity を保ちます。
    serializerCause = new Error("serializer failed");
    await expect(client.cast({ query: "message" })).rejects.toBe(serializerCause);

    // セッションを終了します。
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * // ! ready 接続が drop し、client は recovery policy を待っている
   * const sending = client.cast({ query: () => createFreshPayload() });
   * const receiving = client.next({ selector });
   * // factory と selector は recovery/provisioning 中には呼ばれない
   * // ! 代替接続が ready になる
   * await sending; // factory を初めて評価し、代替接続から送信する
   * await receiving; // ready 後の message だけを観測する
   * ```
   */
  it("recovery 中に受け付けた operation を次の ready まで待機させる", async () => {
    // 最初の接続を ready にしてから drop させます。
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    scenario.drop();
    const recovery = scenario.reconnector.invocations.take();

    // recovery 中に送受信 operation を開始しても、利用者コードはまだ評価されません。
    let factoryCalls = 0;
    let selectorCalls = 0;
    const sending = scenario.client.cast({
      query: () => {
        factoryCalls += 1;
        return "fresh";
      },
    });
    const receiving = scenario.client.next({
      selector: (message) => {
        selectorCalls += 1;
        return message === "application";
      },
    });
    expect(factoryCalls).toBe(0);
    expect(selectorCalls).toBe(0);

    // 代替接続の provisioning message も通常 operation から隠します。
    recovery.reconnect();
    const replacement = scenario.transport.current;
    replacement.emitOpen();
    replacement.emitMessage("provisioning");
    expect(factoryCalls).toBe(0);
    expect(selectorCalls).toBe(0);

    // 代替接続を ready にすると、初回送信と通常受信が開始します。
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    await sending;
    expect(factoryCalls).toBe(1);
    expect(replacement.sent).toEqual(["fresh"]);
    replacement.emitMessage("application");
    await expect(receiving).resolves.toBe("application");
    expect(selectorCalls).toBe(1);

    // 回復後のセッションを終了します。
    const closing = scenario.client.close();
    replacement.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const opening = client.open(async () => waitForProvisioning());
   * const response = client.next({ selector, timeout: 100 });
   * // ! provisioning が完了しないまま受付から100msが経過する
   * await response; // ready 待機中でも UniplsTimeoutError で reject する
   * ```
   */
  it("受付時から provisioning 待機を含めて一つの timeout を進める", async () => {
    // 仮想時計で、接続自体の timeout より先に operation deadline を進めます。
    vi.useFakeTimers();
    try {
      const transport = new ControlledWebSocketServer();
      const provisioner = new ControlledProvisioner();
      const client = new Unipls<string, string>({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
      });
      const opening = client.open(provisioner.setupConnection);
      const socket = transport.current;
      socket.emitOpen();
      const invocation = provisioner.invocations.take();
      const response = client.next({ selector: () => true, timeout: 100 });

      // ! ready にならなくても、受付からの wall-clock deadline で operation だけが終了します。
      await vi.advanceTimersByTimeAsync(100);
      await expect(response).rejects.toBeInstanceOf(UniplsTimeoutError);

      // provisioning を完了してセッションを閉じると、operation の timer は残りません。
      provisioner.succeed(invocation);
      await opening;
      const closing = client.close();
      socket.emitClose();
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ```ts
   * const completed = client.next({ selector, signal, timeout: 100 });
   * await completed; // 成功時に timer、abort listener、message 登録を解放する
   * const aborted = client.next({ selector, signal: anotherSignal });
   * controller.abort(cause);
   * await aborted; // 中断時にも同じ資源を一度だけ解放する
   * ```
   */
  it("成功・中断・timeout の各終了経路で operation 資源を一度だけ解放する", async () => {
    // timer と外部 AbortSignal の listener 操作を観測できる ready な client を作ります。
    vi.useFakeTimers();
    try {
      const transport = new ControlledWebSocketServer();
      const client = new Unipls<string, string>({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
      });
      const opening = client.open();
      const socket = transport.current;
      socket.emitOpen();
      await opening;

      // 正常完了では外部 abort listener を解除し、deadline timer も破棄します。
      const completedController = new AbortController();
      const completedRemove = vi.spyOn(completedController.signal, "removeEventListener");
      const completed = client.next({
        selector: (message) => message === "done",
        signal: completedController.signal,
        timeout: 100,
      });
      socket.emitMessage("done");
      await expect(completed).resolves.toBe("done");
      expect(completedRemove).toHaveBeenCalledTimes(1);

      // abort が勝った場合も同じ cleanup gate を通り、元の reason で一度だけ終了します。
      const abortedController = new AbortController();
      const abortedRemove = vi.spyOn(abortedController.signal, "removeEventListener");
      const cause = new Error("aborted");
      const aborted = client.next({
        selector: () => true,
        signal: abortedController.signal,
        timeout: 100,
      });
      abortedController.abort(cause);
      await expect(aborted).rejects.toBe(cause);
      expect(abortedRemove).toHaveBeenCalledTimes(1);

      // timeout 後に message が届いても operation は復活せず、selector は実行されません。
      let selectorCalls = 0;
      const timedOut = client.next({
        selector: () => {
          selectorCalls += 1;
          return true;
        },
        timeout: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(timedOut).rejects.toBeInstanceOf(UniplsTimeoutError);
      socket.emitMessage("late");
      expect(selectorCalls).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      // セッションを終了します。
      const closing = client.close();
      socket.emitClose();
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});
