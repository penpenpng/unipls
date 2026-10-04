import { describe, expect, it } from "vite-plus/test";

import { Unipls, UniplsDroppedError, UniplsOpenError } from "../../../src/index.ts";
import {
  closeClient,
  ControlledWebSocketServer,
  openClient,
  UniplsRaceScenario,
} from "../../support/index.ts";

describe("stream の終了結果", () => {
  /**
   * ```ts
   * const opening = client.open(provisioner);
   * const messages = client.listen({});
   * // ! 最初の接続のprovisioningが失敗し、sessionがreadyにならない
   * // opening、iteration、closedが同じUniplsOpenErrorを共有する
   * ```
   */
  it("initial open の terminal failure を同じ open error で stream へ通知する", async () => {
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
   * const callbackStream = client.listen({ onMatch: consume });
   * const iterableStream = client.listen({});
   * await client.close();
   * // 両方のclosedは { ok: true, reason: "closed" }
   * // pending iterator.next()もthrowせずdoneになる
   * ```
   */
  it("利用者の session close を全 stream の正常終了にする", async () => {
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const socket = await openClient(client, transport);
    const callbackStream = client.listen({ onMatch: () => {} });
    const iterableStream = client.listen({});
    const pending = iterableStream[Symbol.asyncIterator]().next();
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
  it("abort reason を包まず closed と iterator で同じ値を共有する", async () => {
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
  ])("recovery の $mode で stream を $outcome へ一度だけ終了する", async ({ mode, outcome }) => {
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
});
