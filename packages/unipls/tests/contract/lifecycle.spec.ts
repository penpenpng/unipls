import { describe, expect, it } from "vite-plus/test";

import { ControlledProvisioner, flushMicrotasks, UniplsRaceScenario } from "../support/index.ts";

describe("Unipls lifecycle", () => {
  it("publishes frozen snapshots with stable identity through initial readiness", async () => {
    const scenario = new UniplsRaceScenario();
    const transitions: Array<{ previous: unknown; current: unknown }> = [];
    const getterMatchesEvent: boolean[] = [];
    scenario.client.on("lifecycle", (event) => {
      transitions.push(event);
      getterMatchesEvent.push(scenario.client.lifecycle === event.current);
      expect(Object.isFrozen(event)).toBe(true);
    });

    const idle = scenario.client.lifecycle;
    expect(idle).toEqual({ phase: "closed", reason: "idle" });
    expect(Object.isFrozen(idle)).toBe(true);
    expect(scenario.client.lifecycle).toBe(idle);

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

    scenario.transport.connection(0).emitOpen();
    const provisioning = scenario.client.lifecycle;
    expect(provisioning).toMatchObject({
      phase: "provisioning",
      session: connecting.session,
      connection: connecting.connection,
    });
    expect(scenario.client.lifecycle).toBe(provisioning);

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
    expect(open.attempts[0]).toMatchObject({ outcome: "ready", origin: "initial" });
    expect(Object.isFrozen(open.attempts[0])).toBe(true);

    expect(transitions.at(-1)?.current).toBe(open);
    expect(transitions.every(({ current }) => Object.isFrozen(current))).toBe(true);
    expect(getterMatchesEvent.every(Boolean)).toBe(true);

    const closing = scenario.client.close();
    scenario.transport.connection(0).emitClose({ code: 1000, wasClean: true });
    await closing;
    const closed = scenario.client.lifecycle;
    await scenario.client.close();
    expect(scenario.client.lifecycle).toBe(closed);
  });

  it("keeps the logical session and changes the connection across recovery", async () => {
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

    scenario.drop(0);
    const recovering = scenario.client.lifecycle;
    expect(recovering).toMatchObject({ phase: "recovering", session: firstOpen.session });
    expect(dropped[0]).toMatchObject({
      session: firstOpen.session,
      connection: firstOpen.connection,
    });

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

    scenario.transport.connection(1).emitOpen();
    const secondProvisioning = scenario.provisioner.invocations.take();
    const secondProvisioningContext = secondProvisioning.context as {
      session: unknown;
      isSessionBeginning: boolean;
    };
    expect(secondProvisioningContext.session).toBe(firstOpen.session);
    expect(secondProvisioningContext.isSessionBeginning).toBe(false);
    scenario.provisioner.succeed(secondProvisioning);
    await flushMicrotasks();
    await flushMicrotasks();

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

    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("runs session setup once and connection setup for every transport epoch", async () => {
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

    const opening = scenario.client.open(provisioner);
    scenario.transport.connection(0).emitOpen();
    await opening;
    const firstOpen = scenario.client.lifecycle;
    if (firstOpen.phase !== "open") {
      throw new Error("Expected the first connection to be open");
    }

    scenario.drop(0);
    scenario.reconnector.invocations.take().reconnect();
    scenario.transport.connection(1).emitOpen();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(sessionSetups).toHaveLength(1);
    expect(connectionSetups).toHaveLength(2);
    expect(sessionSetups[0]).toMatchObject({ session: firstOpen.session });
    expect(connectionSetups[1]).toMatchObject({
      session: firstOpen.session,
      isSessionBeginning: false,
    });

    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("validates duplicate open before changing the active lifecycle", async () => {
    const scenario = new UniplsRaceScenario();
    const opening = scenario.beginOpen();
    const beforeDuplicate = scenario.client.lifecycle;
    const replacementProvisioner = new ControlledProvisioner();

    expect(() => scenario.client.open(replacementProvisioner)).toThrow();
    expect(scenario.client.lifecycle).toBe(beforeDuplicate);

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
    await flushMicrotasks();
    await flushMicrotasks();

    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });

  it("creates a new logical session after the previous session closes", async () => {
    const scenario = new UniplsRaceScenario();
    const firstOpening = scenario.beginOpen();
    scenario.transport.connection(0).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await firstOpening;
    const firstOpen = scenario.client.lifecycle;
    if (firstOpen.phase !== "open") {
      throw new Error("Expected the first logical session to be open");
    }

    const firstClosing = scenario.client.close();
    scenario.transport.connection(0).emitClose({ code: 1000, wasClean: true });
    await firstClosing;

    const secondOpening = scenario.beginOpen();
    const secondConnecting = scenario.client.lifecycle;
    if (secondConnecting.phase !== "connecting" || secondConnecting.status !== "attempting") {
      throw new Error("Expected the second logical session to be connecting");
    }
    expect(secondConnecting.session).not.toBe(firstOpen.session);
    expect(secondConnecting.connection).not.toBe(firstOpen.connection);

    scenario.transport.connection(1).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await secondOpening;
    const secondClosing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await secondClosing;
  });

  it("records a provisioning failure without exposing a ready connection", async () => {
    const scenario = new UniplsRaceScenario();
    const cause = new Error("authentication rejected");
    const opening = scenario.beginOpen();
    scenario.transport.connection(0).emitOpen();
    scenario.provisioner.fail(scenario.provisioner.invocations.take(), cause);

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

    scenario.transport.connection(0).emitClose({ code: 1000, wasClean: true });
  });
});
