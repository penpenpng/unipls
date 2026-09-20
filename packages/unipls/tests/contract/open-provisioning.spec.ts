import { describe, expect, it } from "vite-plus/test";

import { flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

describe("Unipls open readiness contract", () => {
  it("keeps open pending until provisioning succeeds", async () => {
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    const transport = scenario.transport.connection(0);
    let settled = false;
    void opening.finally(() => {
      settled = true;
    });

    transport.emitOpen();
    const provisioning = scenario.provisioner.invocations.take();
    await flushMicrotasks();
    expect(settled).toBe(false);

    scenario.provisioner.succeed(provisioning);
    await opening;
    expect(settled).toBe(true);

    const closing = scenario.client.close();
    transport.emitClose({ code: 1000, wasClean: true });
    await closing;
  });
});
