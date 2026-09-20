import { describe, expect, it, vi } from "vite-plus/test";

import { UniplsSocket } from "../../src/index.ts";
import {
  ControlledWebSocketServer,
  flushMicrotasks,
  UniplsRaceScenario,
} from "../support/index.ts";

describe("transport epoch isolation", () => {
  it("ignores stale transport events after a recovery attempt starts", async () => {
    // Arrange public event observers and establish the first ready epoch.
    const scenario = new UniplsRaceScenario({ detectorCount: 1 });
    const messages: string[] = [];
    const errors: unknown[] = [];
    scenario.client.on("message", ({ message }) => messages.push(message));
    scenario.client.on("error", ({ error }) => errors.push(error));

    const opening = scenario.beginOpen();
    const first = scenario.transport.connection(0);
    first.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    const firstDetector = scenario.detectors[0].invocations.take();

    // Drop the first epoch and start its replacement without opening it yet.
    scenario.drop(0);
    const recovery = scenario.reconnector.invocations.take();
    recovery.reconnect();
    const reconnecting = scenario.client.lifecycle;

    // Replay every stale callback source, including the detector captured by epoch one.
    first.emitOpen();
    first.emitMessage("stale message");
    first.emitError(new Error("stale error"));
    first.emitClose({ code: 4100, wasClean: false });
    firstDetector.drop();
    // Drain delayed callbacks once so a stale async continuation would become observable.
    await flushMicrotasks();

    // Verify stale work changed neither lifecycle, public events, nor the new socket.
    expect(scenario.client.lifecycle).toBe(reconnecting);
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
    expect(scenario.transport.connection(1).closeRequests).toEqual([]);
    expect(firstDetector.cleanupCount).toBe(1);
    expect(first.listenerCount("open")).toBe(0);
    expect(first.listenerCount("message")).toBe(0);
    expect(first.listenerCount("error")).toBe(0);
    expect(first.listenerCount("close")).toBe(0);

    // Complete and clean up the current replacement epoch.
    const second = scenario.transport.connection(1);
    second.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");

    const closing = scenario.client.close();
    second.emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("does not let delayed provisioning make an obsolete epoch ready", async () => {
    // Arrange an initially ready session and record its public open events.
    const scenario = new UniplsRaceScenario({ detectorCount: 1 });
    const opened: unknown[] = [];
    scenario.client.on("open", (event) => opened.push(event));

    const opening = scenario.beginOpen();
    scenario.transport.connection(0).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;
    scenario.detectors[0].invocations.take();

    // Start a second epoch and hold its provisioning completion.
    scenario.drop(0);
    scenario.reconnector.invocations.take().reconnect();
    scenario.transport.connection(1).emitOpen();
    const obsoleteProvisioning = scenario.provisioner.invocations.take();

    // Drop the provisioning epoch and begin a third, current attempt.
    scenario.drop(1);
    scenario.reconnector.invocations.take().reconnect();
    const currentConnecting = scenario.client.lifecycle;

    // Release the obsolete hook and drain its continuation once.
    scenario.provisioner.succeed(obsoleteProvisioning);
    await flushMicrotasks();

    // Verify the obsolete epoch published neither readiness nor detector resources.
    expect(scenario.client.lifecycle).toBe(currentConnecting);
    expect(opened).toHaveLength(1);
    expect(scenario.detectors[0].invocations.size).toBe(0);

    // Complete the third epoch and wait for its semantic ready transition.
    const current = scenario.transport.connection(2);
    current.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    expect(opened).toHaveLength(2);

    // Clean up the surviving epoch.
    const closing = scenario.client.close();
    current.emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("binds a waiting send to the socket from the same epoch", async () => {
    // Use virtual time so the first epoch can time out without wall-clock delay.
    vi.useFakeTimers();
    try {
      const transport = new ControlledWebSocketServer();
      const socket = new UniplsSocket<string, string>({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
        timeout: 100,
      });

      // Queue a forced send while the first socket is still connecting, then time it out.
      const firstOpening = socket.open();
      const firstSend = socket.enqueue("obsolete", { force: true });
      const first = transport.connection(0);
      await vi.advanceTimersByTimeAsync(100);
      await expect(firstOpening).rejects.toThrow();

      // Open a replacement epoch; the obsolete payload must not migrate to its socket.
      const secondOpening = socket.open();
      const second = transport.connection(1);
      second.emitOpen();
      await secondOpening;

      // Verify rejection, socket ownership, and callback/listener cleanup for epoch one.
      await expect(firstSend).rejects.toThrow();
      expect(first.sent).toEqual([]);
      expect(second.sent).toEqual([]);
      expect(first.listenerCount("open")).toBe(0);
      expect(first.listenerCount("message")).toBe(0);
      expect(first.listenerCount("error")).toBe(0);
      expect(first.listenerCount("close")).toBe(0);

      // Close epoch two and verify all virtual timers were released.
      const closing = socket.close();
      second.emitClose({ code: 1000, wasClean: true });
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // Restore the process-wide timer implementation even if an assertion fails.
      vi.useRealTimers();
    }
  });
});
