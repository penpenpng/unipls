import { describe, expect, it } from "vite-plus/test";

import { UniplsClosedError, UniplsDroppedError, UniplsOpenError } from "../../../src/index.ts";
import { flushMicrotasks, UniplsRaceScenario } from "../../support/index.ts";

async function openReady(scenario: UniplsRaceScenario): Promise<void> {
  const opening = scenario.beginOpen();
  scenario.transport.current.emitOpen();
  scenario.provisioner.succeed(scenario.provisioner.invocations.take());
  await opening;
}

describe("再接続エンジン", () => {
  /**
   * ```ts
   * const reconnector = {
   *   setup({ reconnect }) {
   *     retryLater(reconnect);
   *   },
   * };
   * const client = new Unipls({ url, reconnector });
   * const opening = client.open(provisioner);
   * // ! 初回接続が失敗し、reconnector が再試行を開始する
   * // reconnector が再試行を続ける間は opening は未完了
   * // ! 再試行した接続が初めて ready になる
   * await opening; // いずれかの接続が初めて ready になった時点で解決する
   * ```
   */
  it("初回の接続失敗後も同じ open を保留して再試行を成功させる", async () => {
    // 最初の transport を接続前に失敗させ、policy へ判断を渡します。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const opening = scenario.beginOpen();
    let settled = false;
    void opening.finally(() => {
      settled = true;
    });
    scenario.transport.connection(0).emitClose({ code: 4100, reason: "temporary" });
    await flushMicrotasks();
    const policy = scenario.reconnector.invocations.take();

    // 失敗履歴を変更できず、元の canonical drop が policy へ渡ることを確認します。
    expect(settled).toBe(false);
    expect(policy.context).toMatchObject({
      origin: "initial",
      stage: "connecting",
      attempt: 1,
    });
    expect(policy.context.drop?.close?.code).toBe(4100);
    expect(policy.context.attempts).toHaveLength(1);
    expect(policy.context.attempts[0]).toMatchObject({ outcome: "failed", attempt: 1 });
    expect(Object.isFrozen(policy.context)).toBe(true);
    expect(Object.isFrozen(policy.context.attempts)).toBe(true);
    expect(Object.isFrozen(policy.context.attempts[0])).toBe(true);

    // 同じ論理セッションで2回目の接続を ready にし、元の open を解決します。
    policy.reconnect();
    scenario.transport.connection(1).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    expect(scenario.client.lifecycle).toMatchObject({ phase: "open" });
    if (scenario.client.lifecycle.phase !== "open") throw new Error("Expected open lifecycle");
    expect(scenario.client.lifecycle.attempts).toMatchObject([
      { outcome: "failed", origin: "initial", attempt: 1 },
      { outcome: "ready", origin: "initial", attempt: 2 },
    ]);
    expect(policy.cleanupCount).toBe(1);

    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  /**
   * ```ts
   * const reconnector = {
   *   setup(actions, context) {
   *     // provisioning の失敗を接続失敗と区別して再試行できる
   *     if (context.stage === "provisioning") actions.reconnect();
   *   },
   * };
   * const client = new Unipls({ url, reconnector });
   * const opening = client.open({
   *   setupConnection: () => provisionConnection(),
   * });
   * // ! WebSocket 接続後、初回の provisionConnection() が失敗する
   * // ! reconnector が開始した次の接続では provisioning が成功する
   * await opening;
   * ```
   */
  it("初回 provisioning 失敗も同じ試行モデルで再試行する", async () => {
    // provisioning を失敗させ、接続段階と区別された context を受け取ります。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const cause = new Error("temporary authentication service failure");
    const opening = scenario.beginOpen();
    scenario.transport.connection(0).emitOpen();
    scenario.provisioner.fail(scenario.provisioner.invocations.take(), cause);
    await flushMicrotasks();
    const policy = scenario.reconnector.invocations.take();
    expect(policy.context).toMatchObject({
      origin: "initial",
      stage: "provisioning",
      attempt: 1,
      cause,
    });

    // policy の再試行によって次の provisioning を完了します。
    policy.reconnect();
    scenario.transport.connection(1).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    expect(scenario.client.lifecycle).toMatchObject({ phase: "open" });

    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  /**
   * ```ts
   * const reconnector = {
   *   setup(actions) {
   *     shouldRetry ? actions.reconnect() : actions.cancel();
   *     // 試行余地を使い切った場合は actions.exhaust() も選べる
   *   },
   * };
   * const opening = new Unipls({ url, reconnector }).open(provisioner);
   * // ! 初回接続または provisioning が失敗し、reconnector.setup() が呼ばれる
   * // cancel は attempts-cancelled、exhaust は attempts-exhausted の
   * // UniplsOpenError で opening を一度だけ失敗させる
   * ```
   */
  it.each([
    { action: "cancel" as const, outcome: "attempts-cancelled" as const },
    { action: "exhaust" as const, outcome: "attempts-exhausted" as const },
  ])("初回失敗後の $action を open の終端結果にする", async ({ action, outcome }) => {
    // 初回 provisioning を失敗させて policy action を待ちます。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const cause = new Error("attempt failed");
    const opening = scenario.beginOpen();
    scenario.transport.current.emitOpen();
    scenario.provisioner.fail(scenario.provisioner.invocations.take(), cause);
    await flushMicrotasks();
    const policy = scenario.reconnector.invocations.take();

    // cancel と exhaustion が対応する open error を一度だけ返すことを確認します。
    if (action === "cancel") policy.cancel();
    else policy.exhaust();
    const error = await opening.catch((failure) => failure as UniplsOpenError);
    expect(error).toMatchObject({ name: "UniplsOpenError", outcome, cause });
    expect(scenario.client.lifecycle).toMatchObject({ phase: "closed", reason: "open-failed" });
    expect(policy.cleanupCount).toBe(1);
  });

  /**
   * ```ts
   * const reconnector = {
   *   setup() {
   *     throw policyError; // Promise.reject(policyError) でも同じ
   *   },
   * };
   * const client = new Unipls({ url, reconnector });
   * const client = new Unipls({ url, logSink: ({ context, cause }) => {
   *   // error は open() が投げる UniplsOpenError と同じ参照で、cause は policyError
   * });
   * const opening = client.open();
   * // ! 初回接続が失敗し、reconnector.setup() が呼ばれる
   * await opening; // log.context.error と同じ UniplsOpenError を投げる
   * ```
   */
  it.each([
    { failurePoint: "setup" as const, reject: false },
    { failurePoint: "policy" as const, reject: true },
  ])(
    "初回 reconnector の $failurePoint 失敗を同じ error の診断へ変換する",
    async ({ failurePoint, reject }) => {
      // reconnector が同期 throw または非同期 reject する初回失敗を作ります。
      const scenario = new UniplsRaceScenario({ detectorCount: 0 });
      const cause = new Error(`${failurePoint} failed`);
      if (reject) scenario.reconnector.rejectNextSetup(cause);
      else scenario.reconnector.failNextSetup(cause);
      const opening = scenario.beginOpen();
      scenario.transport.current.emitClose({ code: 4100 });
      const error = await opening.then(
        () => undefined,
        (failure) => failure as UniplsOpenError,
      );
      await flushMicrotasks();

      // open、lifecycle、log が同じ原因と terminal error を共有します。
      if (!error) throw new Error("Expected open failure");
      expect(error).toMatchObject({ outcome: "reconnector-failed", cause });
      expect(error.stage).toBeUndefined();
      expect(scenario.logs).toHaveLength(1);
      expect(scenario.logs[0]).toMatchObject({
        event: "resilience/reconnection",
        level: "error",
        context: { origin: "initial", failurePoint, error },
        cause,
      });
      expect(scenario.logs[0]?.cause).toBe(error.cause);
      expect(Object.isFrozen(scenario.logs[0])).toBe(true);
      expect(Object.isFrozen(scenario.logs[0]?.context)).toBe(true);
    },
  );

  /**
   * ```ts
   * const reconnector = {
   *   setup({ reconnect }) {
   *     const timer = setTimeout(reconnect, 1000);
   *     return () => clearTimeout(timer);
   *   },
   * };
   * const client = new Unipls({ url, reconnector });
   * const opening = client.open();
   * // ! 初回接続が失敗し、policy の timer が再試行を待っている
   * await client.close(); // opening は UniplsClosedError で失敗する
   * // close 後に古い reconnect callback が呼ばれても新しい接続を開始しない
   * ```
   */
  it("初回 policy 待機中の close と stale action を session-closed に収束させる", async () => {
    // 初回失敗後、再試行 action を保留します。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const opening = scenario.beginOpen();
    scenario.transport.current.emitClose({ code: 4100 });
    await flushMicrotasks();
    const policy = scenario.reconnector.invocations.take();

    // 明示 close 後の古い action が transport を復活させないことを確認します。
    await scenario.client.close();
    await expect(opening).rejects.toBeInstanceOf(UniplsClosedError);
    policy.replayReconnect();
    expect(scenario.transport.connections).toHaveLength(1);
    expect(policy.cleanupCount).toBe(1);
    expect(scenario.client.lifecycle).toMatchObject({ phase: "closed", reason: "user" });
  });

  /**
   * ```ts
   * const reconnector = {
   *   setup(actions, context) {
   *     // 回復試行が失敗するたびに再実行される
   *     // context には同じ drop、失敗段階、原因、凍結された全試行履歴が入る
   *     decide(actions, context);
   *   },
   * };
   * const client = new Unipls({ url, reconnector });
   * await client.open(provisioner);
   * // ! ready 接続が drop し、最初の回復試行の provisioning も失敗する
   * // この時点で setup() が同じ drop と更新済みの試行履歴を受け取って再実行される
   * ```
   */
  it("失敗した回復試行の後に同じ drop で policy を再実行する", async () => {
    // ready 接続を drop し、最初の回復試行を provisioning まで進めます。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    await openReady(scenario);
    scenario.drop(0);
    const firstPolicy = scenario.reconnector.invocations.take();
    const canonicalDrop = firstPolicy.context.drop;
    firstPolicy.reconnect();
    scenario.transport.connection(1).emitOpen();
    const retryCause = new Error("retry provisioning failed");
    scenario.provisioner.fail(scenario.provisioner.invocations.take(), retryCause);
    await flushMicrotasks();
    const secondPolicy = scenario.reconnector.invocations.take();

    // 2回目の判断が失敗内容と不変な全履歴を受け取ることを確認します。
    expect(secondPolicy.context).toMatchObject({
      origin: "recovery",
      stage: "provisioning",
      attempt: 1,
      cause: retryCause,
      drop: canonicalDrop,
    });
    expect(secondPolicy.context.attempts).toMatchObject([
      { outcome: "ready", origin: "initial", attempt: 1 },
      { outcome: "failed", origin: "recovery", attempt: 1 },
    ]);
    expect(Object.isFrozen(secondPolicy.context.attempts)).toBe(true);
    expect(firstPolicy.cleanupCount).toBe(1);

    // 次の試行を ready にして succeeded outcome を通知します。
    const reconnectEvents: unknown[] = [];
    scenario.client.on("reconnect", (event) => reconnectEvents.push(event));
    secondPolicy.reconnect();
    secondPolicy.replayReconnect();
    scenario.transport.connection(2).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    expect(reconnectEvents).toMatchObject([{ outcome: "succeeded" }]);
    expect(scenario.transport.connections).toHaveLength(3);
    expect(secondPolicy.cleanupCount).toBe(1);

    const closing = scenario.client.close();
    scenario.transport.connection(2).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  /**
   * ```ts
   * await client.open();
   * // ! 1回目のdropから回復に成功する
   * // ! 回復後の接続もdropする
   * // 2回目のreconnector contextは同じsessionと、それまでの全attempt履歴を持つ
   * ```
   */
  it("回復成功後の次のdropへ同じsessionと累積attempt履歴を渡す", async () => {
    // 初回接続をreadyにして、最初のrecovery cycleを開始します。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    await openReady(scenario);
    const initial = scenario.client.lifecycle;
    if (initial.phase !== "open") throw new Error("open状態が必要です");
    scenario.drop(0);
    const firstPolicy = scenario.reconnector.invocations.take();
    firstPolicy.reconnect();
    const firstReplacement = scenario.transport.connection(1);
    firstReplacement.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");

    // ! 回復済みの接続が再びdropし、次のpolicy contextが作られます。
    scenario.drop(1);
    const secondPolicy = scenario.reconnector.invocations.take();
    expect(secondPolicy.context.origin).toBe("recovery");
    expect(secondPolicy.context.session).toBe(initial.session);
    expect(secondPolicy.context.attempts).toMatchObject([
      { sequence: 1, cycle: 0, attempt: 1, outcome: "ready" },
      { sequence: 2, cycle: 1, attempt: 1, outcome: "ready" },
    ]);
    expect(Object.isFrozen(secondPolicy.context.attempts)).toBe(true);
    expect(firstPolicy.cleanupCount).toBe(1);

    secondPolicy.cancel();
  });

  /**
   * ```ts
   * const reconnector = {
   *   async setup() {
   *     throw policyError;
   *   },
   * };
   * const client = new Unipls({ url, reconnector });
   * await client.open();
   * const waiting = client.next({ selector, retry: "wait" });
   * const client = new Unipls({ url, logSink: ({ context }) => {
   *   // error は waiting と closed event が受け取る UniplsDroppedError と同じ参照
   * });
   * // ! ready 接続が drop し、回復のために呼ばれた setup() が reject する
   * await waiting; // policyError を cause に持つ UniplsDroppedError を投げる
   * ```
   */
  it("回復 policy の非同期失敗を dropped error と同じ診断へ変換する", async () => {
    // ready 接続の drop 後に policy Promise を reject させます。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const cause = new Error("policy rejected");
    const closed: UniplsDroppedError[] = [];
    scenario.client.on("closed", ({ error }) => {
      if (error instanceof UniplsDroppedError) closed.push(error);
    });
    await openReady(scenario);
    const waiting = scenario.client.next({ selector: () => false, retry: "wait" });
    scenario.reconnector.rejectNextSetup(cause);
    scenario.drop(0);
    await flushMicrotasks();
    const operationError = await waiting.then(
      () => undefined,
      (error) => error as UniplsDroppedError,
    );

    // session と診断が同じ dropped error を保持して一度だけ終了します。
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ outcome: "reconnector-failed", cause });
    expect(scenario.logs).toHaveLength(1);
    expect(scenario.logs[0]).toMatchObject({
      event: "resilience/reconnection",
      level: "error",
      context: { origin: "recovery", failurePoint: "policy", error: closed[0] },
      cause,
    });
    expect(operationError).toBe(closed[0]);
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "closed",
      reason: "dropped",
      outcome: "reconnector-failed",
    });
  });
});
