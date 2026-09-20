import { describe, expect, it } from "vite-plus/test";

import {
  UniplsClosedError,
  UniplsDroppedError,
  UniplsOpenError,
  type UniplsDiagnostic,
} from "../../src/index.ts";
import { flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

async function openReady(scenario: UniplsRaceScenario): Promise<void> {
  const opening = scenario.beginOpen();
  scenario.transport.current.emitOpen();
  scenario.provisioner.succeed(scenario.provisioner.invocations.take());
  await opening;
}

describe("再接続エンジン", () => {
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

  it.each([
    { failurePoint: "setup" as const, reject: false },
    { failurePoint: "policy" as const, reject: true },
  ])(
    "初回 reconnector の $failurePoint 失敗を同じ error の診断へ変換する",
    async ({ failurePoint, reject }) => {
      // reconnector が同期 throw または非同期 reject する初回失敗を作ります。
      const scenario = new UniplsRaceScenario({ detectorCount: 0 });
      const cause = new Error(`${failurePoint} failed`);
      const diagnostics: UniplsDiagnostic[] = [];
      scenario.client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
      if (reject) scenario.reconnector.rejectNextSetup(cause);
      else scenario.reconnector.failNextSetup(cause);
      const opening = scenario.beginOpen();
      scenario.transport.current.emitClose({ code: 4100 });
      const error = await opening.then(
        () => undefined,
        (failure) => failure as UniplsOpenError,
      );
      await flushMicrotasks();

      // open、lifecycle、diagnostic が同じ原因と terminal error を共有します。
      if (!error) throw new Error("Expected open failure");
      expect(error).toMatchObject({ outcome: "reconnector-failed", cause });
      expect(error.stage).toBeUndefined();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        type: "reconnector-failed",
        context: "initial-open",
        failurePoint,
        cause,
      });
      if (diagnostics[0]?.type !== "reconnector-failed") throw new Error("Expected diagnostic");
      expect(diagnostics[0].error).toBe(error);
      expect(diagnostics[0].cause).toBe(error.cause);
      expect(Object.isFrozen(diagnostics[0])).toBe(true);
      expect(Object.isFrozen(diagnostics[0].scope)).toBe(true);
    },
  );

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

  it("回復 policy の非同期失敗を dropped error と同じ診断へ変換する", async () => {
    // ready 接続の drop 後に policy Promise を reject させます。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const cause = new Error("policy rejected");
    const diagnostics: UniplsDiagnostic[] = [];
    const closed: UniplsDroppedError[] = [];
    scenario.client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
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
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      type: "reconnector-failed",
      context: "recovery",
      failurePoint: "policy",
      cause,
    });
    if (diagnostics[0]?.type !== "reconnector-failed") throw new Error("Expected diagnostic");
    expect(diagnostics[0].error).toBe(closed[0]);
    expect(operationError).toBe(closed[0]);
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "closed",
      reason: "dropped",
      outcome: "reconnector-failed",
    });
  });
});
