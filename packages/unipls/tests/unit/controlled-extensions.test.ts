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

describe("controlled extension hooks", () => {
  it("pauses hooks at independently resolvable and rejectable invocations", async () => {
    const hook = new ControlledHook<{ attempt: number }, string>();
    const firstResult = hook.invoke({ attempt: 1 });
    const first = hook.invocations.take();
    first.resolve("ready");

    const failure = new Error("provisioning failed");
    const secondResult = hook.invoke({ attempt: 2 });
    const second = hook.invocations.take();
    second.reject(failure);

    await expect(firstResult).resolves.toBe("ready");
    await expect(secondResult).rejects.toBe(failure);
    expect(first.state).toBe("resolved");
    expect(second.state).toBe("rejected");
  });

  it("controls provisioning, reconnect, cancel, and detector drop actions", async () => {
    const provisioner = new ControlledProvisioner<{ connection: number }>();
    const provisioning = provisioner.setupConnection({ connection: 1 });
    const provision = provisioner.invocations.take();
    provisioner.succeed(provision);
    await expect(provisioning).resolves.toBeUndefined();

    const reconnectCalls = new CallbackProbe();
    const cancelCalls = new CallbackProbe();
    const reconnector = new ControlledReconnector();
    const cleanup = reconnector.setup(
      { reconnect: reconnectCalls.callback, cancel: cancelCalls.callback },
      {
        session,
        sessionAttempts: [],
        allAttempts: [],
        signal: new AbortController().signal,
      },
    );
    const reconnection = reconnector.invocations.take();
    reconnection.reconnect();
    cleanup();

    const secondCleanup = reconnector.setup(
      { reconnect: reconnectCalls.callback, cancel: cancelCalls.callback },
      {
        session,
        sessionAttempts: [],
        allAttempts: [],
        signal: new AbortController().signal,
      },
    );
    const cancelledReconnection = reconnector.invocations.take();
    cancelledReconnection.cancel();
    secondCleanup();

    const dropCalls = new CallbackProbe();
    const detector = new ControlledDropDetector<{ drop(): void }>();
    const disposeDetector = detector.setup({ drop: dropCalls.callback });
    const detection = detector.invocations.take();
    detection.drop();
    disposeDetector();

    expect(reconnectCalls.calls).toHaveLength(1);
    expect(cancelCalls.calls).toHaveLength(1);
    expect(reconnection.cleanupCount).toBe(1);
    expect(cancelledReconnection.cleanupCount).toBe(1);
    expect(dropCalls.calls).toHaveLength(1);
    expect(detection.cleanupCount).toBe(1);
  });

  it("can stop a reconnector at setup failure", () => {
    const reconnector = new ControlledReconnector();
    const failure = new Error("policy setup failed");
    reconnector.failNextSetup(failure);

    expect(() =>
      reconnector.setup(
        { reconnect() {}, cancel() {} },
        {
          session,
          sessionAttempts: [],
          allAttempts: [],
          signal: new AbortController().signal,
        },
      ),
    ).toThrow(failure);
  });
});

describe("resource observation probes", () => {
  it("observes callback, timer, and disposer release without real time", () => {
    const callback = new CallbackProbe<[string]>();
    const scheduler = new ManualScheduler();
    const disposals = new DisposalProbe();

    const cancelled = scheduler.setTimeout(() => callback.callback("cancelled"), 5);
    scheduler.setTimeout(() => callback.callback("ran"), 10);
    scheduler.clearTimeout(cancelled);
    scheduler.advanceBy(10);

    const first = disposals.disposer("first");
    const second = disposals.disposer("second");
    second();
    first();

    expect(callback.calls).toEqual([["ran"]]);
    expect(scheduler.pendingCount).toBe(0);
    expect(disposals.records.map(({ name }) => name)).toEqual(["second", "first"]);
    expect(disposals.count("first")).toBe(1);
  });
});
