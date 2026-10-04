import { describe, expect, it } from "vite-plus/test";

import { UniplsDroppedError } from "../../../src/index.ts";
import { flushMicrotasks, UniplsRaceScenario } from "../../support/index.ts";

describe("operation の recovery", () => {
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
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();

    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    scenario.drop();
    const recovery = scenario.reconnector.invocations.take();
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
    recovery.reconnect();
    const replacement = scenario.transport.current;

    replacement.emitOpen();
    replacement.emitMessage("provisioning");
    expect(factoryCalls).toBe(0);
    expect(selectorCalls).toBe(0);
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    await sending;
    expect(factoryCalls).toBe(1);
    expect(replacement.sent).toEqual(["fresh"]);
    replacement.emitMessage("application");
    await expect(receiving).resolves.toBe("application");
    expect(selectorCalls).toBe(1);
    const closing = scenario.client.close();

    replacement.emitClose();
    await closing;
  });

  /**
   * ```ts
   * // ! 接続が drop し、client が recovery action を待っている
   * const response = client.request({
   *   query: () => createRequest(),
   *   selector,
   *   retry: "fail",
   * });
   * // createRequest はまだ呼ばれず、retry policy も適用されない
   * // ! 代替接続が ready になる
   * await response; // 代替接続で初回送信してから応答を待つ
   * ```
   */
  it("recovery 中に作った未送信 request を retry ではなく初回送信として扱う", async () => {
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();

    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    scenario.drop();
    const recovery = scenario.reconnector.invocations.take();
    let factoryCalls = 0;
    const response = scenario.client.request({
      query: () => `request-${++factoryCalls}`,
      selector: (message) => message === "response",
      retry: "fail",
    });

    expect(factoryCalls).toBe(0);
    recovery.reconnect();
    const replacement = scenario.transport.current;

    replacement.emitOpen();
    replacement.emitMessage("response");
    expect(factoryCalls).toBe(0);
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    await flushMicrotasks();
    expect(factoryCalls).toBe(1);
    expect(replacement.sent).toEqual(["request-1"]);
    replacement.emitMessage("response");
    await expect(response).resolves.toBe("response");
    const closing = scenario.client.close();

    replacement.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const failed = client.request({ query, selector });
   * const waited = client.request({ query, selector, retry: "wait" });
   * const resent = client.request({ query: factory, selector, retry: "resend" });
   * // ! 3件の初回送信後に接続が drop し、代替接続が ready になる
   * await failed; // canonical drop を持つ UniplsDroppedError で終了する
   * await waited; // 再送せず、代替接続上の応答を観測する
   * await resent; // factory を再評価してから代替接続へ明示的に再送する
   * ```
   */
  it("request の fail・wait・resend を送信試行済み payload にだけ適用する", async () => {
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();

    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    const first = scenario.transport.current;
    let resendFactoryCalls = 0;
    const failed = scenario.client.request({
      query: "fail-request",
      selector: (message) => message === "fail-response",
    });
    const waited = scenario.client.request({
      query: "wait-request",
      selector: (message) => message === "wait-response",
      retry: "wait",
    });
    const resent = scenario.client.request({
      query: () => `resend-request-${++resendFactoryCalls}`,
      selector: (message) => message === "resend-response",
      retry: "resend",
    });

    await flushMicrotasks();
    expect(first.sent).toEqual(["fail-request", "wait-request", "resend-request-1"]);

    // ! drop の時点で既定 fail だけが終了し、wait と resend は次の ready を待ちます。
    scenario.drop();
    const dropSnapshot = scenario.client.lifecycle;

    if (dropSnapshot.phase !== "recovering") {
      throw new Error("Expected recovery");
    }

    const failedError = await failed.then(
      () => undefined,
      (error) => error,
    );

    if (!(failedError instanceof UniplsDroppedError)) {
      throw new Error("Expected drop error");
    }

    expect(failedError).toMatchObject({ outcome: "operation-failed" });
    expect(failedError.drop).toBe(dropSnapshot.drop);
    const recovery = scenario.reconnector.invocations.take();

    recovery.reconnect();
    const replacement = scenario.transport.current;

    replacement.emitOpen();
    scenario.client.on(
      "open",
      () => {
        // ! ready 遷移と同じ同期処理中に届く応答も、wait は観測できます。
        replacement.emitMessage("wait-response");
      },
      { once: true },
    );
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    await flushMicrotasks();
    expect(replacement.sent).toEqual(["resend-request-2"]);
    expect(resendFactoryCalls).toBe(2);
    replacement.emitMessage("resend-response");
    await expect(waited).resolves.toBe("wait-response");
    await expect(resent).resolves.toBe("resend-response");
    const closing = scenario.client.close();

    replacement.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const response = client.request({
   *   query: originalFactory,
   *   selector: originalSelector,
   *   retry: {
   *     recover: ({ query, selector, reconnection }) => ({
   *       query: recoveredFactory,
   *       selector: recoveredSelector,
   *     }),
   *   },
   * });
   * // ! 初回送信後に drop し、代替接続が ready になる
   * await response; // recover が選んだ factory と selector だけで回復する
   * ```
   */
  it("custom recovery が選んだ query と selector で request を回復する", async () => {
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();

    scenario.transport.current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    let originalFactoryCalls = 0;
    let recoveredFactoryCalls = 0;
    const recoveryInputs: unknown[] = [];
    const originalFactory = () => `original-${++originalFactoryCalls}`;
    const response = scenario.client.request({
      query: originalFactory,
      selector: (message) => message === "original-response",
      retry: {
        recover: (context) => {
          recoveryInputs.push(context);

          return {
            query: () => `recovered-${++recoveredFactoryCalls}`,
            selector: (message) => message === "recovered-response",
          };
        },
      },
    });

    await flushMicrotasks();
    expect(scenario.transport.current.sent).toEqual(["original-1"]);

    // ! drop 後の ready 通知で custom recovery を一度だけ評価します。
    scenario.drop();
    const recovery = scenario.reconnector.invocations.take();

    recovery.reconnect();
    const replacement = scenario.transport.current;

    replacement.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    await flushMicrotasks();
    expect(recoveryInputs).toHaveLength(1);
    expect(recoveryInputs[0]).toMatchObject({ query: originalFactory });
    expect(originalFactoryCalls).toBe(1);
    expect(recoveredFactoryCalls).toBe(1);
    expect(replacement.sent).toEqual(["recovered-1"]);
    replacement.emitMessage("original-response");
    replacement.emitMessage("recovered-response");
    await expect(response).resolves.toBe("recovered-response");
    const closing = scenario.client.close();

    replacement.emitClose();
    await closing;
  });
});
