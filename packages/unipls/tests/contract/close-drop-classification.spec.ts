import { describe, expect, it, vi } from "vite-plus/test";

import {
  Unipls,
  UniplsClosedError,
  type UniplsDrop,
  UniplsDroppedError,
  UniplsOpenError,
  UniplsTimeoutError,
} from "../../src/index.ts";
import {
  ControlledDropDetector,
  type ControlledReconnectorInvocation,
  ControlledWebSocketServer,
  UniplsRaceScenario,
} from "../support/index.ts";

async function openScenario(scenario: UniplsRaceScenario): Promise<void> {
  const opening = scenario.beginOpen();
  scenario.transport.current.emitOpen();
  scenario.provisioner.succeed(scenario.provisioner.invocations.take());
  await opening;
}

describe("close と drop の分類", () => {
  /**
   * ```ts
   * const client = new Unipls({ url, reconnector });
   * client.on("dropped", ({ drop }) => {
   *   // peer の close code が 1000 でも 4100 でも呼ばれ、drop.close に情報が残る
   *   inspect(drop.close);
   * });
   * await client.open();
   * // ! peer を drop させる
   * ```
   */
  it.each([
    { code: 1000, reason: "peer finished", wasClean: true },
    { code: 4100, reason: "peer failed", wasClean: false },
  ])("open intent 中の peer close を drop に分類する: $code", async (close) => {
    // open intent を保った ready 接続を作ります。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const dropped: Array<{ drop: UniplsDrop; error: UniplsDroppedError }> = [];
    scenario.client.on("dropped", (event) => dropped.push(event));
    await openScenario(scenario);

    // peer close の情報を与え、回復へ渡される canonical drop を確認します。
    scenario.transport.current.emitClose(close);
    const recovery = scenario.reconnector.invocations.take();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.drop).toMatchObject({
      source: { type: "peer-close" },
      close,
    });
    expect(Object.isFrozen(dropped[0]?.drop)).toBe(true);
    expect(Object.isFrozen(dropped[0]?.drop.source)).toBe(true);
    expect(Object.isFrozen(dropped[0]?.drop.close)).toBe(true);
    expect(dropped[0]?.error.drop).toBe(dropped[0]?.drop);
    expect(recovery.context.drop).toBe(dropped[0]?.drop);
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "recovering",
      drop: dropped[0]?.drop,
    });

    // 保留中の回復操作を残さないようセッションを終了します。
    recovery.cancel();
  });

  /**
   * ```ts
   * client.on("dropped", () => {
   *   // client.close() に伴う WebSocket close では呼ばれない
   * });
   * await client.open();
   * const closing = client.close();
   * // ! close intent の確定後に、peer から非正常 code の close event が届く
   * await closing; // lifecycle は reason: "user" で終了する
   * ```
   */
  it("利用者の close intent 後の transport close を利用者による終了に分類する", async () => {
    // ready 接続を作り、drop 通知の有無を観測します。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const dropped: unknown[] = [];
    scenario.client.on("dropped", (event) => dropped.push(event));
    await openScenario(scenario);

    // 非正常 code の close event より先に利用者の close intent を確定します。
    const closing = scenario.client.close();
    scenario.transport.current.emitClose({
      code: 4100,
      reason: "late peer close",
      wasClean: false,
    });
    await closing;

    expect(dropped).toEqual([]);
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "closed",
      reason: "user",
    });
  });

  /**
   * ```ts
   * const client = new Unipls({ url }); // reconnector なし
   * const opening = client.open();
   * // ! WebSocket の接続成立前に peer が接続を閉じる
   * await opening; // close code、reason、wasClean を持つ UniplsOpenError を投げる
   * ```
   */
  it("接続成立前の peer close を初回 open error に記録する", async () => {
    // 初回試行を開始し、接続成立前に peer close を発生させます。
    const scenario = new UniplsRaceScenario({
      detectorCount: 0,
      reconnectable: false,
    });
    const opening = scenario.beginOpen();
    scenario.transport.current.emitClose({
      code: 1000,
      reason: "refused",
      wasClean: true,
    });
    const error = await opening.then(
      () => undefined,
      (cause) => cause as UniplsOpenError,
    );

    // 初回試行の error と終了 snapshot が同じ peer-close drop を保持することを確認します。
    expect(error).toBeInstanceOf(UniplsOpenError);
    expect(error?.drop).toMatchObject({
      source: { type: "peer-close" },
      close: { code: 1000, reason: "refused", wasClean: true },
    });
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "closed",
      reason: "open-failed",
      drop: error?.drop,
    });
  });

  /**
   * ```ts
   * const constructionError = new Error("WebSocket construction failed");
   * class CustomWebSocket extends WebSocket {
   *   constructor() {
   *     throw constructionError;
   *   }
   * }
   * const client = new Unipls({ url, WebSocket: CustomWebSocket });
   * await client.open(); // constructionError を cause に持つ UniplsOpenError を投げる
   * ```
   */
  it("socket 生成時の同期例外を transport drop として記録する", async () => {
    // socket を返す前に失敗する WebSocket constructor を用意します。
    const cause = new Error("socket construction failed");
    const WebSocket = class {
      constructor() {
        throw cause;
      }
    } as unknown as typeof globalThis.WebSocket;
    const client = new Unipls({ url: "wss://unipls.test/socket", WebSocket });

    const error = await client.open().then(
      () => undefined,
      (failure) => failure as UniplsOpenError,
    );

    // 生成時の原因と transport-error の検出元が正規化後も保持されることを確認します。
    expect(error).toBeInstanceOf(UniplsOpenError);
    expect(error?.drop).toMatchObject({
      source: { type: "transport-error" },
      cause,
    });
    expect(error?.cause).toBe(cause);

    // socket を得られなかった接続試行も明示 close で終了することを確認します。
    await client.close();
    expect(client.intent).toBe("close");
    expect(client.state).toBe("closed");
  });

  /**
   * ```ts
   * const client = new Unipls({ url, timeout: 100 });
   * const opening = client.open();
   * // ! WebSocket が接続しないまま100msが経過する
   * await opening; // timeout 由来の drop と UniplsTimeoutError を持つ error を投げる
   * ```
   */
  it("接続 timeout を timeout 由来の drop として記録する", async () => {
    // 仮想時間を進め、接続中の WebSocket を期限へ到達させます。
    vi.useFakeTimers();
    try {
      const transport = new ControlledWebSocketServer();
      const client = new Unipls({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
        timeout: 100,
      });
      const opening = client.open();
      await vi.advanceTimersByTimeAsync(100);
      const error = await opening.then(
        () => undefined,
        (failure) => failure as UniplsOpenError,
      );

      expect(error?.drop).toMatchObject({ source: { type: "timeout" } });
      expect(error?.drop?.cause).toBeInstanceOf(UniplsTimeoutError);
      expect(transport.current.closeRequests).toEqual([{ code: 3002, reason: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ```ts
   * const first = { name: "heartbeat", setup: () => () => {} };
   * const second = { name: "heartbeat", setup: () => () => {} };
   * new Unipls({ url, dropDetectors: [first, second] });
   * // WebSocket を生成する前に、重複した detector 名を示す例外を投げる
   * ```
   */
  it("明示的な detector 名の重複を拒否する", () => {
    // 同じ detector 名を2回登録し、WebSocket 生成前に拒否されることを確認します。
    const transport = new ControlledWebSocketServer();
    expect(
      () =>
        new Unipls({
          url: "wss://unipls.test/socket",
          WebSocket: transport.WebSocket,
          dropDetectors: [
            new ControlledDropDetector("heartbeat"),
            new ControlledDropDetector("heartbeat"),
          ],
        }),
    ).toThrow("Drop detector name must be unique: heartbeat");
    expect(transport.connections).toEqual([]);
  });

  /**
   * ```ts
   * const first = { name: "heartbeat", setup: ({ drop }) => startFirstCheck(drop) };
   * const second = { name: "offline", setup: ({ drop }) => startSecondCheck(drop) };
   * const client = new Unipls({ url, reconnector, dropDetectors: [first, second] });
   * client.on("dropped", ({ drop }) => {
   *   // 最初に drop() を呼んだ detector だけが drop.source に残り、1回だけ通知される
   * });
   * await client.open();
   * // ! offline 検知が先に drop() を呼び、続いて heartbeat や transport も報告する
   * ```
   */
  it("最初の detector 報告だけを drop の勝者にする", async () => {
    // 1つの ready 接続に対して名前付き detector を2つ開始します。
    const scenario = new UniplsRaceScenario({ detectorCount: 2 });
    const dropped: Array<{ drop: UniplsDrop }> = [];
    scenario.client.on("dropped", (event) => dropped.push(event));
    await openScenario(scenario);
    const firstDetector = scenario.detectors[0].invocations.take();
    const secondDetector = scenario.detectors[1].invocations.take();

    // detector、transport error、peer close、manual drop を指定順で競合させます。
    secondDetector.drop();
    firstDetector.drop();
    scenario.transport.current.emitError(new Error("late transport error"));
    scenario.transport.current.emitClose({ code: 4100, wasClean: false });
    scenario.client.drop();

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.drop.source).toEqual({
      type: "detector",
      detector: { registrationIndex: 1, name: "detector-1" },
    });
    if (dropped[0]?.drop.source.type !== "detector") {
      throw new Error("Expected a detector drop");
    }
    expect(dropped[0].drop.source.detector).toBe(
      (
        secondDetector.context as {
          detector: unknown;
        }
      ).detector,
    );
    expect(Object.isFrozen(dropped[0].drop.source)).toBe(true);
    expect(Object.isFrozen(dropped[0].drop.source.detector)).toBe(true);
    expect(firstDetector.cleanupCount).toBe(1);
    expect(secondDetector.cleanupCount).toBe(1);
    expect(scenario.transport.current.closeRequests).toHaveLength(1);
    expect(scenario.reconnector.invocations.size).toBe(1);

    scenario.reconnector.invocations.take().cancel();
  });

  /**
   * ```ts
   * client.on("dropped", ({ drop }) => {
   *   // client.drop() なら source.type は "manual-drop"
   *   // WebSocket error なら source.type は "transport-error" で元の cause を保持する
   * });
   * await client.open();
   * // ! manual の場合は次の行を実行し、transport-error の場合は WebSocket error が発生する
   * client.drop(); // どちらの経路でも一つの不変な UniplsDrop に正規化される
   * ```
   */
  it.each([{ source: "manual" as const }, { source: "transport-error" as const }])(
    "$source の報告を1つの canonical drop に正規化する",
    async ({ source }) => {
      // ready 接続を作り、公開される drop を記録します。
      const scenario = new UniplsRaceScenario({ detectorCount: 0 });
      const dropped: Array<{ drop: UniplsDrop }> = [];
      scenario.client.on("dropped", (event) => dropped.push(event));
      await openScenario(scenario);

      const cause = new Error("transport failed");
      if (source === "manual") {
        scenario.client.drop();
      } else {
        scenario.transport.current.emitError(cause);
      }

      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.drop.source.type).toBe(
        source === "manual" ? "manual-drop" : "transport-error",
      );
      if (source === "transport-error") {
        expect(dropped[0]?.drop.cause).toBe(cause);
      }
      scenario.reconnector.invocations.take().cancel();
    },
  );
});

describe("回復の終端結果", () => {
  /**
   * ```ts
   * await client.open();
   * const waiting = client.next({ selector, retry: "wait" });
   * // ! 接続が drop し、reconnector が次の action を待つ
   * await client.close(); // 回復待機中でも reconnector resource を一度だけ破棄する
   * await waiting; // UniplsClosedError を投げる
   * ```
   */
  it("回復中に利用者が close すると待機中の操作も終了する", async () => {
    // ready 接続を回復中にし、操作を待機状態に保ちます。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const closed: unknown[] = [];
    scenario.client.on("closed", (event) => closed.push(event));
    await openScenario(scenario);
    const waiting = scenario.client.next({
      selector: () => false,
      retry: "wait",
    });
    scenario.drop(0);
    const recovery = scenario.reconnector.invocations.take();

    // 明示 close が操作と回復 resource を1回だけ終了することを確認します。
    await scenario.client.close();
    await expect(waiting).rejects.toBeInstanceOf(UniplsClosedError);
    expect(closed).toHaveLength(1);
    expect(recovery.cleanupCount).toBe(1);
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "closed",
      reason: "user",
    });
    expect(scenario.client.intent).toBe("close");
    expect(scenario.client.state).toBe("closed");
  });

  /**
   * ```ts
   * const reconnector = {
   *   setup(actions) {
   *     decideWhetherToRecover(actions.cancel, actions.exhaust, actions.reconnect);
   *   },
   * };
   * const client = new Unipls({ url, reconnector });
   * await client.open();
   * const waiting = client.next({ selector, retry: "wait" });
   * // ! 接続が drop し、reconnector が cancel、exhaust、失敗のいずれかに至る
   * await waiting; // cancel、exhaust、reconnector failure を区別する UniplsDroppedError を投げる
   * // この時点で終了した session は後から再開しない
   * ```
   */
  it.each([
    { mode: "cancel" as const, outcome: "recovery-cancelled" as const },
    { mode: "exhaust" as const, outcome: "recovery-exhausted" as const },
    { mode: "setup-failure" as const, outcome: "reconnector-failed" as const },
    { mode: "no-reconnector" as const, outcome: "recovery-exhausted" as const },
  ])("$mode でセッションの resource を終了する", async ({ mode, outcome }) => {
    // ready セッションと、drop をまたいで待機する操作を作ります。
    const scenario = new UniplsRaceScenario({
      detectorCount: 0,
      reconnectable: mode !== "no-reconnector",
    });
    const closedErrors: UniplsDroppedError[] = [];
    scenario.client.on("closed", ({ error }) => {
      if (error instanceof UniplsDroppedError) closedErrors.push(error);
    });
    await openScenario(scenario);
    const firstOpen = scenario.client.lifecycle;
    if (firstOpen.phase !== "open") throw new Error("Expected an open session");
    const waiting = scenario.client.next({
      selector: () => false,
      retry: "wait",
    });
    const cause = new Error(`${mode} cause`);
    if (mode === "setup-failure") scenario.reconnector.failNextSetup(cause);

    // 接続を drop した後、指定された回復終了操作を選びます。
    scenario.drop(0);
    let recovery: ControlledReconnectorInvocation | undefined;
    if (mode === "cancel") {
      recovery = scenario.reconnector.invocations.take();
      recovery.cancel();
    }
    if (mode === "exhaust") {
      recovery = scenario.reconnector.invocations.take();
      recovery.exhaust(cause);
    }

    const rejection = await waiting.then(
      () => undefined,
      (error) => error as UniplsDroppedError,
    );
    expect(closedErrors).toHaveLength(1);
    expect(rejection).toBe(closedErrors[0]);
    expect(rejection).toMatchObject({ name: "UniplsDroppedError", outcome });
    if (recovery) expect(recovery.cleanupCount).toBe(1);
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "closed",
      reason: "dropped",
      outcome,
      drop: rejection?.drop,
    });
    expect(scenario.client.state).toBe("closed");
    const terminal = scenario.client.lifecycle;
    await scenario.client.close();
    expect(scenario.client.lifecycle).toBe(terminal);

    // 後続の open が別の論理セッションと WebSocket 接続を作ることを確認します。
    const reopening = scenario.beginOpen();
    const nextConnecting = scenario.client.lifecycle;
    if (nextConnecting.phase !== "connecting" || nextConnecting.status !== "attempting") {
      throw new Error("Expected a new connecting session");
    }
    expect(nextConnecting.session).not.toBe(firstOpen.session);
    scenario.transport.connection(1).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await reopening;
    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });
});
