import { describe, expect, it } from "vite-plus/test";

import { ControlledProvisioner, UniplsRaceScenario } from "../support/index.ts";

describe("Unipls の lifecycle", () => {
  it("初回 ready まで同一性が安定した不変の snapshot を通知する", async () => {
    // idle な client を作り、すべての lifecycle 通知を記録します。
    const scenario = new UniplsRaceScenario();
    const transitions: Array<{ previous: unknown; current: unknown }> = [];
    const getterMatchesEvent: boolean[] = [];
    scenario.client.on("lifecycle", (event) => {
      transitions.push(event);
      getterMatchesEvent.push(scenario.client.lifecycle === event.current);
      expect(Object.isFrozen(event)).toBe(true);
    });

    // 接続試行前の初期 snapshot を確認します。
    const idle = scenario.client.lifecycle;
    expect(idle).toEqual({ phase: "closed", reason: "idle" });
    expect(Object.isFrozen(idle)).toBe(true);
    expect(scenario.client.lifecycle).toBe(idle);

    // 論理セッションを開始し、同期的に公開される connecting snapshot を確認します。
    const opening = scenario.beginOpen();
    const connecting = scenario.client.lifecycle;
    expect(connecting).toMatchObject({
      phase: "connecting",
      status: "attempting",
      cycle: 0,
      attempt: 1,
      origin: "initial",
      attempts: [],
    });
    if (connecting.phase !== "connecting" || connecting.status !== "attempting") {
      throw new Error("Expected an active initial connection attempt");
    }
    expect(typeof connecting.session).toBe("string");
    expect(typeof connecting.connection).toBe("string");
    expect(Object.isFrozen(connecting)).toBe(true);
    expect(Object.isFrozen(connecting.attempts)).toBe(true);

    // WebSocket を開き、制御 gate で provisioning を保留します。
    scenario.transport.connection(0).emitOpen();
    const provisioning = scenario.client.lifecycle;
    expect(provisioning).toMatchObject({
      phase: "provisioning",
      session: connecting.session,
      connection: connecting.connection,
    });
    expect(scenario.client.lifecycle).toBe(provisioning);

    // provisioning を成功させ、ready 試行と lifecycle event の同一性を確認します。
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    const open = scenario.client.lifecycle;
    expect(open).toMatchObject({
      phase: "open",
      session: connecting.session,
      connection: connecting.connection,
    });
    if (open.phase !== "open") {
      throw new Error("Expected an open lifecycle");
    }
    expect(open.attempts).toHaveLength(1);
    expect(open.attempts[0]).toMatchObject({
      outcome: "ready",
      origin: "initial",
    });
    expect(Object.isFrozen(open.attempts[0])).toBe(true);

    expect(transitions.at(-1)?.current).toBe(open);
    expect(transitions.every(({ current }) => Object.isFrozen(current))).toBe(true);
    expect(getterMatchesEvent.every(Boolean)).toBe(true);

    // セッションを閉じ、2回目の close が snapshot を変えないことを確認します。
    const closing = scenario.client.close();
    scenario.transport.connection(0).emitClose({ code: 1000, wasClean: true });
    await closing;
    const closed = scenario.client.lifecycle;
    await scenario.client.close();
    expect(scenario.client.lifecycle).toBe(closed);
  });

  it("回復時は論理セッションを維持して接続 ID を更新する", async () => {
    // observer を登録し、最初の接続を ready にします。
    const scenario = new UniplsRaceScenario();
    const opened: Array<{ session: unknown; connection: unknown }> = [];
    const dropped: Array<{ session: unknown; connection: unknown }> = [];
    scenario.client.on("open", (event) => opened.push(event));
    scenario.client.on("dropped", (event) => dropped.push(event));
    const opening = scenario.beginOpen();
    scenario.transport.connection(0).emitOpen();
    const firstProvisioning = scenario.provisioner.invocations.take();
    const firstProvisioningContext = firstProvisioning.context as {
      session: unknown;
      isSessionBeginning: boolean;
    };
    scenario.provisioner.succeed(firstProvisioning);
    await opening;

    // 最初の provisioning と open event が同じ論理セッションを使うことを確認します。
    const firstOpen = scenario.client.lifecycle;
    if (firstOpen.phase !== "open") {
      throw new Error("Expected the first connection to be open");
    }
    expect(firstProvisioningContext.session).toBe(firstOpen.session);
    expect(firstProvisioningContext.isSessionBeginning).toBe(true);
    expect(opened[0]).toMatchObject({
      session: firstOpen.session,
      connection: firstOpen.connection,
    });

    // 最初の接続を drop し、回復 snapshot と drop event を確認します。
    scenario.drop(0);
    const recovering = scenario.client.lifecycle;
    expect(recovering).toMatchObject({
      phase: "recovering",
      session: firstOpen.session,
    });
    expect(dropped[0]).toMatchObject({
      session: firstOpen.session,
      connection: firstOpen.connection,
    });

    // 次の試行を開始し、セッションを維持したまま connection ID が変わることを確認します。
    const reconnection = scenario.reconnector.invocations.take();
    expect(reconnection.context.session).toBe(firstOpen.session);
    reconnection.reconnect();

    const reconnecting = scenario.client.lifecycle;
    expect(reconnecting).toMatchObject({
      phase: "connecting",
      status: "attempting",
      origin: "recovery",
      session: firstOpen.session,
    });
    if (reconnecting.phase !== "connecting" || reconnecting.status !== "attempting") {
      throw new Error("Expected a recovery connection attempt");
    }
    expect(reconnecting.connection).not.toBe(firstOpen.connection);

    // 代替接続の provisioning を完了し、ready への遷移を待ちます。
    scenario.transport.connection(1).emitOpen();
    const secondProvisioning = scenario.provisioner.invocations.take();
    const secondProvisioningContext = secondProvisioning.context as {
      session: unknown;
      isSessionBeginning: boolean;
    };
    expect(secondProvisioningContext.session).toBe(firstOpen.session);
    expect(secondProvisioningContext.isSessionBeginning).toBe(false);
    scenario.provisioner.succeed(secondProvisioning);
    await scenario.waitForLifecycle(({ phase }) => phase === "open");

    const secondOpen = scenario.client.lifecycle;
    expect(secondOpen).toMatchObject({
      phase: "open",
      session: firstOpen.session,
      connection: reconnecting.connection,
    });
    expect(opened[1]).toMatchObject({
      session: firstOpen.session,
      connection: reconnecting.connection,
    });

    // 代替接続を終了します。
    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("session setup は一度、connection setup は接続ごとに実行する", async () => {
    // 論理セッションと WebSocket 接続の setup 回数を別々に記録します。
    const scenario = new UniplsRaceScenario();
    const sessionSetups: unknown[] = [];
    const connectionSetups: unknown[] = [];
    const provisioner = {
      setupSession(context: unknown) {
        sessionSetups.push(context);
      },
      setupConnection(context: unknown) {
        connectionSetups.push(context);
      },
    };

    // 両方の setup hook を実行する初回接続を ready にします。
    const opening = scenario.client.open(provisioner);
    scenario.transport.connection(0).emitOpen();
    await opening;
    const firstOpen = scenario.client.lifecycle;
    if (firstOpen.phase !== "open") {
      throw new Error("Expected the first connection to be open");
    }

    // 2つ目の接続へ回復し、両方の setup が完了するまで待ちます。
    scenario.drop(0);
    scenario.reconnector.invocations.take().reconnect();
    scenario.transport.connection(1).emitOpen();
    await scenario.waitForLifecycle(({ phase }) => phase === "open");

    // session hook は繰り返さず、connection hook だけを再実行することを確認します。
    expect(sessionSetups).toHaveLength(1);
    expect(connectionSetups).toHaveLength(2);
    expect(sessionSetups[0]).toMatchObject({ session: firstOpen.session });
    expect(connectionSetups[1]).toMatchObject({
      session: firstOpen.session,
      isSessionBeginning: false,
    });

    // 回復後の接続を終了します。
    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("active lifecycle を変更する前に重複 open を拒否する", async () => {
    // active な open 試行と、置き換えられてはならない provisioner を用意します。
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    const beforeDuplicate = scenario.client.lifecycle;
    const replacementProvisioner = new ControlledProvisioner();

    // 無効な2回目の open を試し、lifecycle が変化しないことを確認します。
    expect(() => scenario.client.open(replacementProvisioner)).toThrow();
    expect(scenario.client.lifecycle).toBe(beforeDuplicate);

    // 元の試行を完了し、回復時にも同じ provisioner が使われることを確認します。
    scenario.transport.connection(0).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;

    scenario.drop(0);
    const reconnection = scenario.reconnector.invocations.take();
    reconnection.reconnect();
    scenario.transport.connection(1).emitOpen();
    const originalProvisionerInvocation = scenario.provisioner.invocations.take();
    expect(replacementProvisioner.invocations.size).toBe(0);
    scenario.provisioner.succeed(originalProvisionerInvocation);
    await scenario.waitForLifecycle(({ phase }) => phase === "open");

    // 回復試行が作成した接続を終了します。
    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("前のセッション終了後の open で新しい論理セッションを作る", async () => {
    // 最初の論理セッションを ready にし、その ID を記録します。
    const scenario = new UniplsRaceScenario();
    const firstOpening = scenario.beginOpen();
    scenario.transport.connection(0).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await firstOpening;
    const firstOpen = scenario.client.lifecycle;
    if (firstOpen.phase !== "open") {
      throw new Error("Expected the first logical session to be open");
    }

    // 最初のセッションを終了します。
    const firstClosing = scenario.client.close();
    scenario.transport.connection(0).emitClose({ code: 1000, wasClean: true });
    await firstClosing;

    // 新しいセッションを開始し、session ID と connection ID を比較します。
    const secondOpening = scenario.beginOpen();
    const secondConnecting = scenario.client.lifecycle;
    if (secondConnecting.phase !== "connecting" || secondConnecting.status !== "attempting") {
      throw new Error("Expected the second logical session to be connecting");
    }
    expect(secondConnecting.session).not.toBe(firstOpen.session);
    expect(secondConnecting.connection).not.toBe(firstOpen.connection);

    // 2つ目のセッションを ready にしてから終了します。
    scenario.transport.connection(1).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await secondOpening;
    const secondClosing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await secondClosing;
  });

  it("ready 接続を公開せずに provisioning 失敗を記録する", async () => {
    // 既知の原因で provisioning が失敗する初回接続を用意します。
    const scenario = new UniplsRaceScenario({ reconnectable: false });
    const cause = new Error("authentication rejected");
    const opening = scenario.beginOpen();
    scenario.transport.connection(0).emitOpen();
    scenario.provisioner.fail(scenario.provisioner.invocations.take(), cause);

    // 公開される open error と対応する終了 snapshot を確認します。
    await expect(opening).rejects.toMatchObject({
      name: "UniplsOpenError",
      outcome: "attempt-failed",
      cause,
    });
    const failed = scenario.client.lifecycle;
    expect(failed).toMatchObject({
      phase: "closed",
      reason: "open-failed",
      outcome: "attempt-failed",
      cause,
    });
    if (failed.phase !== "closed" || failed.reason !== "open-failed") {
      throw new Error("Expected a terminal initial-open failure");
    }
    expect(failed.attempts).toHaveLength(1);
    expect(failed.attempts[0]).toMatchObject({
      outcome: "failed",
      stage: "provisioning",
      cause,
    });

    // 遅れて close event を発火し、lifecycle が変化しないことを確認します。
    scenario.transport.connection(0).emitClose({ code: 1000, wasClean: true });
  });
});
