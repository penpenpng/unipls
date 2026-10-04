import { describe, expect, it } from "vite-plus/test";

import type { SessionId } from "../../src/index.ts";
import {
  CallbackProbe,
  ControlledDropDetector,
  ControlledHook,
  ControlledProvisioner,
  ControlledReconnector,
  DisposalProbe,
  ManualScheduler,
} from "../support/index.ts";

const session = "test-session" as SessionId;

describe("制御可能な拡張 hook", () => {
  it("個別に成功または失敗させられる呼び出し位置で hook を停止する", async () => {
    // 制御可能な呼び出しを2つ作り、最初を成功させます。
    const hook = new ControlledHook<{ attempt: number }, string>();
    const firstResult = hook.invoke({ attempt: 1 });
    const first = hook.invocations.take();
    first.resolve("ready");

    // 2つ目を同一性を検証できる値で失敗させます。
    const failure = new Error("provisioning failed");
    const secondResult = hook.invoke({ attempt: 2 });
    const second = hook.invocations.take();
    second.reject(failure);

    // 各 Promise と呼び出し状態が個別の完了結果を反映することを確認します。
    await expect(firstResult).resolves.toBe("ready");
    await expect(secondResult).rejects.toBe(failure);
    expect(first.state).toBe("resolved");
    expect(second.state).toBe("rejected");
  });

  it("provisioning、reconnect、cancel、detector drop を制御する", async () => {
    // 制御可能な provisioning 呼び出しを1件成功させます。
    const provisioner = new ControlledProvisioner<{ connection: number }>();
    const provisioning = provisioner.setupConnection({ connection: 1 });
    const provision = provisioner.invocations.take();
    provisioner.succeed(provision);
    await expect(provisioning).resolves.toBeUndefined();

    // reconnect 操作と disposer を実行します。
    const reconnectCalls = new CallbackProbe();
    const cancelCalls = new CallbackProbe();
    const reconnector = new ControlledReconnector();
    const cleanup = reconnector.setup(
      {
        reconnect: reconnectCalls.callback,
        cancel: cancelCalls.callback,
        exhaust() {},
      },
      {
        session,
        origin: "initial",
        stage: "connecting",
        attempt: 1,
        cause: undefined,
        attempts: Object.freeze([]),
        signal: new AbortController().signal,
      },
    );
    const reconnection = reconnector.invocations.take();
    reconnection.reconnect();
    if (typeof cleanup === "function") {
      cleanup();
    }

    // 別の cancel 操作と disposer を実行します。
    const secondCleanup = reconnector.setup(
      {
        reconnect: reconnectCalls.callback,
        cancel: cancelCalls.callback,
        exhaust() {},
      },
      {
        session,
        origin: "initial",
        stage: "connecting",
        attempt: 2,
        cause: undefined,
        attempts: Object.freeze([]),
        signal: new AbortController().signal,
      },
    );
    const cancelledReconnection = reconnector.invocations.take();
    cancelledReconnection.cancel();
    if (typeof secondCleanup === "function") {
      secondCleanup();
    }

    // detector の drop callback と cleanup を実行します。
    const dropCalls = new CallbackProbe();
    const detector = new ControlledDropDetector<{ drop(): void }>();
    const disposeDetector = detector.setup({ drop: dropCalls.callback });
    const detection = detector.invocations.take();
    detection.drop();
    disposeDetector();

    // すべての操作と cleanup が1回だけ記録されたことを確認します。
    expect(reconnectCalls.calls).toHaveLength(1);
    expect(cancelCalls.calls).toHaveLength(1);
    expect(reconnection.cleanupCount).toBe(1);
    expect(cancelledReconnection.cleanupCount).toBe(1);
    expect(dropCalls.calls).toHaveLength(1);
    expect(detection.cleanupCount).toBe(1);
  });

  it("setup 失敗時に reconnector を停止できる", () => {
    // 次の policy setup が呼び出し公開前に失敗するよう設定します。
    const reconnector = new ControlledReconnector();
    const failure = new Error("policy setup failed");
    reconnector.failNextSetup(failure);

    // 指定した原因が同期的かつ同一の値で通知されることを確認します。
    expect(() =>
      reconnector.setup(
        { reconnect() {}, cancel() {}, exhaust() {} },
        {
          session,
          origin: "initial",
          stage: "connecting",
          attempt: 1,
          cause: failure,
          attempts: Object.freeze([]),
          signal: new AbortController().signal,
        },
      ),
    ).toThrow(failure);
  });
});

describe("resource 観測 probe", () => {
  it("実時間を使わず callback、timer、disposer の解放を観測する", () => {
    // callback、仮想 scheduler、disposer の観測を用意します。
    const callback = new CallbackProbe<[string]>();
    const scheduler = new ManualScheduler();
    const disposals = new DisposalProbe();

    // 一方の task を取り消し、もう一方を実行して仮想時間を進めます。
    const cancelled = scheduler.setTimeout(() => callback.callback("cancelled"), 5);
    scheduler.setTimeout(() => callback.callback("ran"), 10);
    scheduler.clearTimeout(cancelled);
    scheduler.advanceBy(10);

    // 名前付き resource を指定順で2件解放します。
    const first = disposals.disposer("first");
    const second = disposals.disposer("second");
    second();
    first();

    // 有効な処理だけが実行され、すべての timer と disposer が解放されたことを確認します。
    expect(callback.calls).toEqual([["ran"]]);
    expect(scheduler.pendingCount).toBe(0);
    expect(disposals.records.map(({ name }) => name)).toEqual(["second", "first"]);
    expect(disposals.count("first")).toBe(1);
  });
});
