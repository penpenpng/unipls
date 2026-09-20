import { describe, expect, it } from "vite-plus/test";

import { flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

describe("Unipls open readiness contract", () => {
  it("keeps open pending until provisioning succeeds", async () => {
    // Arrange an opening Promise and an independent settlement observation.
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    const transport = scenario.transport.connection(0);
    let settled = false;
    void opening.finally(() => {
      settled = true;
    });

    // Open the transport but keep provisioning blocked at the controlled hook.
    transport.emitOpen();
    const provisioning = scenario.provisioner.invocations.take();
    // Drain pending Promise work once to prove transport-open alone cannot settle open().
    await flushMicrotasks();
    expect(settled).toBe(false);

    // Release provisioning and verify the original opening Promise becomes ready.
    scenario.provisioner.succeed(provisioning);
    await opening;
    expect(settled).toBe(true);

    // Clean up the ready transport.
    const closing = scenario.client.close();
    transport.emitClose({ code: 1000, wasClean: true });
    await closing;
  });
});
