import { describe, expect, it } from "vite-plus/test";

import { flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

describe("UniplsRaceScenario", () => {
  it("assembles stale-connection and multi-detector races deterministically", async () => {
    // Establish a ready connection with two detector invocations.
    const scenario = new UniplsRaceScenario({ detectorCount: 2 });
    const opening = scenario.beginOpen();
    const first = scenario.transport.connection(0);

    first.emitOpen();
    const provisioning = scenario.provisioner.invocations.take();
    scenario.provisioner.succeed(provisioning);
    await opening;

    // Verify both detector controls were initialized with the same epoch context.
    const firstDetector = scenario.detectors[0].invocations.take();
    const secondDetector = scenario.detectors[1].invocations.take();
    expect(firstDetector.context).toBe(secondDetector.context);

    // Race duplicate detector reports, a transport error, and the actual close event.
    secondDetector.drop();
    firstDetector.drop();
    first.emitError(new Error("late transport error"));
    scenario.drop(0);
    const reconnect = scenario.reconnector.invocations.take();
    reconnect.reconnect();
    expect(scenario.transport.connections).toHaveLength(2);

    // Replay stale events from epoch one and drain any delayed continuations once.
    scenario.emitStaleMessage(0, "late message");
    scenario.emitStaleClose(0, { code: 4100, wasClean: false });
    await flushMicrotasks();

    // Verify the scenario retains distinct handles for old and replacement sockets.
    expect(scenario.transport.connection(0)).toBe(first);
    expect(scenario.transport.connection(1)).not.toBe(first);

    // Clean up the still-connecting replacement epoch.
    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("assembles double-open without waiting for real transport time", async () => {
    // Start one opening attempt and synchronously race a duplicate request.
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();

    expect(() => scenario.attemptSecondOpen()).toThrow();

    // Complete the original opening attempt after the duplicate is rejected.
    const first = scenario.transport.connection(0);
    first.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;

    // Clean up the original transport.
    const closing = scenario.client.close();
    first.emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it.each(["close", "reconnect"] as const)(
    "assembles a close/reconnect race with %s winning",
    async (winner) => {
      // Establish a ready epoch before introducing the close/reconnect race.
      const scenario = new UniplsRaceScenario();
      const opening = scenario.beginOpen();
      const first = scenario.transport.connection(0);
      first.emitOpen();
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await opening;

      // Drop it and execute both contenders in the requested deterministic order.
      scenario.drop(0);
      const reconnection = scenario.reconnector.invocations.take();
      const closing = scenario.raceCloseAndReconnect(reconnection, winner);

      // If reconnect created a socket, emit its close so the user close can settle.
      if (winner === "reconnect") {
        scenario.transport
          .connection(1)
          .emitClose({ code: 1000, wasClean: true });
      }
      await closing;

      // Verify only a reconnect-first ordering was allowed to allocate a new epoch.
      expect(scenario.transport.connections).toHaveLength(
        winner === "reconnect" ? 2 : 1,
      );
    },
  );
});
