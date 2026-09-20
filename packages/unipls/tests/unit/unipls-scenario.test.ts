import { describe, expect, it } from "vite-plus/test";

import { flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

describe("UniplsRaceScenario", () => {
  it("assembles stale-connection and multi-detector races deterministically", async () => {
    const scenario = new UniplsRaceScenario({ detectorCount: 2 });
    const opening = scenario.beginOpen();
    const first = scenario.transport.connection(0);

    first.emitOpen();
    const provisioning = scenario.provisioner.invocations.take();
    scenario.provisioner.succeed(provisioning);
    await opening;

    const firstDetector = scenario.detectors[0].invocations.take();
    const secondDetector = scenario.detectors[1].invocations.take();
    expect(firstDetector.context).toBe(secondDetector.context);

    secondDetector.drop();
    firstDetector.drop();
    first.emitError(new Error("late transport error"));
    scenario.drop(0);
    const reconnect = scenario.reconnector.invocations.take();
    reconnect.reconnect();
    expect(scenario.transport.connections).toHaveLength(2);

    scenario.emitStaleMessage(0, "late message");
    scenario.emitStaleClose(0, { code: 4100, wasClean: false });
    await flushMicrotasks();

    expect(scenario.transport.connection(0)).toBe(first);
    expect(scenario.transport.connection(1)).not.toBe(first);

    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("assembles double-open without waiting for real transport time", async () => {
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();

    expect(() => scenario.attemptSecondOpen()).toThrow();

    const first = scenario.transport.connection(0);
    first.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;

    const closing = scenario.client.close();
    first.emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it.each(["close", "reconnect"] as const)(
    "assembles a close/reconnect race with %s winning",
    async (winner) => {
      const scenario = new UniplsRaceScenario();
      const opening = scenario.beginOpen();
      const first = scenario.transport.connection(0);
      first.emitOpen();
      scenario.provisioner.succeed(scenario.provisioner.invocations.take());
      await opening;

      scenario.drop(0);
      const reconnection = scenario.reconnector.invocations.take();
      const closing = scenario.raceCloseAndReconnect(reconnection, winner);

      if (winner === "reconnect") {
        scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
      }
      await closing;

      expect(scenario.transport.connections).toHaveLength(winner === "reconnect" ? 2 : 1);
    },
  );
});
