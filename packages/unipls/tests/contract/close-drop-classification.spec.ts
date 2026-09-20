import { describe, expect, it, vi } from "vite-plus/test";

import {
  Unipls,
  UniplsClosedError,
  type UniplsDrop,
  UniplsDroppedError,
  UniplsOpenError,
  UniplsTimeoutError,
} from "../../src/index.ts";
import {
  ControlledDropDetector,
  type ControlledReconnectorInvocation,
  ControlledWebSocketServer,
  UniplsRaceScenario,
} from "../support/index.ts";

async function openScenario(scenario: UniplsRaceScenario): Promise<void> {
  const opening = scenario.beginOpen();
  scenario.transport.current.emitOpen();
  scenario.provisioner.succeed(scenario.provisioner.invocations.take());
  await opening;
}

describe("close and drop classification", () => {
  it.each([
    { code: 1000, reason: "peer finished", wasClean: true },
    { code: 4100, reason: "peer failed", wasClean: false },
  ])("classifies an open-intent peer close as a drop: $code", async (close) => {
    // Establish a ready connection while retaining open intent.
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const dropped: Array<{ drop: UniplsDrop; error: UniplsDroppedError }> = [];
    scenario.client.on("dropped", (event) => dropped.push(event));
    await openScenario(scenario);

    // Deliver peer close metadata and inspect the canonical recovery input.
    scenario.transport.current.emitClose(close);
    const recovery = scenario.reconnector.invocations.take();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.drop).toMatchObject({
      source: { type: "peer-close" },
      close,
    });
    expect(Object.isFrozen(dropped[0]?.drop)).toBe(true);
    expect(Object.isFrozen(dropped[0]?.drop.source)).toBe(true);
    expect(Object.isFrozen(dropped[0]?.drop.close)).toBe(true);
    expect(dropped[0]?.error.drop).toBe(dropped[0]?.drop);
    expect(recovery.context.drop).toBe(dropped[0]?.drop);
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "recovering",
      drop: dropped[0]?.drop,
    });

    // End the recovery session so the scenario leaves no pending policy action.
    recovery.cancel();
  });

  it("classifies any transport close after user close intent as user closure", async () => {
    // Establish a ready connection and observe whether any drop escapes.
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const dropped: unknown[] = [];
    scenario.client.on("dropped", (event) => dropped.push(event));
    await openScenario(scenario);

    // Set user close intent before a non-normal transport close arrives.
    const closing = scenario.client.close();
    scenario.transport.current.emitClose({
      code: 4100,
      reason: "late peer close",
      wasClean: false,
    });
    await closing;

    expect(dropped).toEqual([]);
    expect(scenario.client.lifecycle).toMatchObject({ phase: "closed", reason: "user" });
  });

  it("records a peer close before transport open on the initial open error", async () => {
    // Begin an initial attempt but close the transport before it opens.
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const opening = scenario.beginOpen();
    scenario.transport.current.emitClose({ code: 1000, reason: "refused", wasClean: true });
    const error = await opening.then(
      () => undefined,
      (cause) => cause as UniplsOpenError,
    );

    // The initial attempt fails, but retains the same canonical peer-close record.
    expect(error).toBeInstanceOf(UniplsOpenError);
    expect(error?.drop).toMatchObject({
      source: { type: "peer-close" },
      close: { code: 1000, reason: "refused", wasClean: true },
    });
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "closed",
      reason: "open-failed",
      drop: error?.drop,
    });
  });

  it("records synchronous socket construction failure as a transport drop", async () => {
    // Provide a WebSocket constructor that fails before a socket exists.
    const cause = new Error("socket construction failed");
    const WebSocket = class {
      constructor() {
        throw cause;
      }
    } as unknown as typeof globalThis.WebSocket;
    const client = new Unipls({ url: "wss://unipls.test/socket", WebSocket });

    const error = await client.open().then(
      () => undefined,
      (failure) => failure as UniplsOpenError,
    );

    // The construction cause and transport-error source survive normalization.
    expect(error).toBeInstanceOf(UniplsOpenError);
    expect(error?.drop).toMatchObject({ source: { type: "transport-error" }, cause });
    expect(error?.cause).toBe(cause);

    // Explicit close also terminates a dropped epoch that never obtained a socket.
    await client.close();
    expect(client.intent).toBe("close");
    expect(client.state).toBe("closed");
  });

  it("records connection timeout as a timeout drop", async () => {
    // Advance a connecting transport to its deadline using virtual time.
    vi.useFakeTimers();
    try {
      const transport = new ControlledWebSocketServer();
      const client = new Unipls({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
        timeout: 100,
      });
      const opening = client.open();
      await vi.advanceTimersByTimeAsync(100);
      const error = await opening.then(
        () => undefined,
        (failure) => failure as UniplsOpenError,
      );

      expect(error?.drop).toMatchObject({ source: { type: "timeout" } });
      expect(error?.drop?.cause).toBeInstanceOf(UniplsTimeoutError);
      expect(transport.current.closeRequests).toEqual([{ code: 3002, reason: undefined }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects duplicate explicit detector names", () => {
    // Registering a detector name twice is rejected before a transport is created.
    const transport = new ControlledWebSocketServer();
    expect(
      () =>
        new Unipls({
          url: "wss://unipls.test/socket",
          WebSocket: transport.WebSocket,
          dropDetectors: [
            new ControlledDropDetector("heartbeat"),
            new ControlledDropDetector("heartbeat"),
          ],
        }),
    ).toThrow("Drop detector name must be unique: heartbeat");
    expect(transport.connections).toEqual([]);
  });

  it("uses the first detector report as the only drop winner", async () => {
    // Establish both named detector callbacks for one ready epoch.
    const scenario = new UniplsRaceScenario({ detectorCount: 2 });
    const dropped: Array<{ drop: UniplsDrop }> = [];
    scenario.client.on("dropped", (event) => dropped.push(event));
    await openScenario(scenario);
    const firstDetector = scenario.detectors[0].invocations.take();
    const secondDetector = scenario.detectors[1].invocations.take();

    // Race detector, transport, peer-close, and manual reports in a fixed order.
    secondDetector.drop();
    firstDetector.drop();
    scenario.transport.current.emitError(new Error("late transport error"));
    scenario.transport.current.emitClose({ code: 4100, wasClean: false });
    scenario.client.drop();

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.drop.source).toEqual({
      type: "detector",
      detector: { registrationIndex: 1, name: "detector-1" },
    });
    if (dropped[0]?.drop.source.type !== "detector") {
      throw new Error("Expected a detector drop");
    }
    expect(Object.isFrozen(dropped[0].drop.source)).toBe(true);
    expect(Object.isFrozen(dropped[0].drop.source.detector)).toBe(true);
    expect(firstDetector.cleanupCount).toBe(1);
    expect(secondDetector.cleanupCount).toBe(1);
    expect(scenario.transport.current.closeRequests).toHaveLength(1);
    expect(scenario.reconnector.invocations.size).toBe(1);

    scenario.reconnector.invocations.take().cancel();
  });

  it.each([{ source: "manual" as const }, { source: "transport-error" as const }])(
    "normalizes a $source report into one canonical drop",
    async ({ source }) => {
      // Establish a ready epoch and capture its public drop record.
      const scenario = new UniplsRaceScenario({ detectorCount: 0 });
      const dropped: Array<{ drop: UniplsDrop }> = [];
      scenario.client.on("dropped", (event) => dropped.push(event));
      await openScenario(scenario);

      const cause = new Error("transport failed");
      if (source === "manual") {
        scenario.client.drop();
      } else {
        scenario.transport.current.emitError(cause);
      }

      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.drop.source.type).toBe(
        source === "manual" ? "manual-drop" : "transport-error",
      );
      if (source === "transport-error") {
        expect(dropped[0]?.drop.cause).toBe(cause);
      }
      scenario.reconnector.invocations.take().cancel();
    },
  );
});

describe("recovery terminal outcomes", () => {
  it("terminates a waiting operation when the user closes during recovery", async () => {
    // Keep an operation pending while a ready connection enters recovery.
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const closed: unknown[] = [];
    scenario.client.on("closed", (event) => closed.push(event));
    await openScenario(scenario);
    const waiting = scenario.client.next({ selector: () => false, retry: "wait" });
    scenario.drop(0);
    const recovery = scenario.reconnector.invocations.take();

    // Explicit close settles the operation and recovery resources exactly once.
    await scenario.client.close();
    await expect(waiting).rejects.toBeInstanceOf(UniplsClosedError);
    expect(closed).toHaveLength(1);
    expect(recovery.cleanupCount).toBe(1);
    expect(scenario.client.lifecycle).toMatchObject({ phase: "closed", reason: "user" });
    expect(scenario.client.intent).toBe("close");
    expect(scenario.client.state).toBe("closed");
  });

  it.each([
    { mode: "cancel" as const, outcome: "recovery-cancelled" as const },
    { mode: "exhaust" as const, outcome: "recovery-exhausted" as const },
    { mode: "setup-failure" as const, outcome: "reconnector-failed" as const },
    { mode: "no-reconnector" as const, outcome: "recovery-exhausted" as const },
  ])("terminates session resources for $mode", async ({ mode, outcome }) => {
    // Establish a ready session and one operation that elects to wait across a drop.
    const scenario = new UniplsRaceScenario({
      detectorCount: 0,
      reconnectable: mode !== "no-reconnector",
    });
    const closedErrors: UniplsDroppedError[] = [];
    scenario.client.on("closed", ({ error }) => {
      if (error) closedErrors.push(error);
    });
    await openScenario(scenario);
    const firstOpen = scenario.client.lifecycle;
    if (firstOpen.phase !== "open") throw new Error("Expected an open session");
    const waiting = scenario.client.next({ selector: () => false, retry: "wait" });
    const cause = new Error(`${mode} cause`);
    if (mode === "setup-failure") scenario.reconnector.failNextSetup(cause);

    // Drop the epoch, then choose the requested terminal policy outcome.
    scenario.drop(0);
    let recovery: ControlledReconnectorInvocation | undefined;
    if (mode === "cancel") {
      recovery = scenario.reconnector.invocations.take();
      recovery.cancel();
    }
    if (mode === "exhaust") {
      recovery = scenario.reconnector.invocations.take();
      recovery.exhaust(cause);
    }

    const rejection = await waiting.then(
      () => undefined,
      (error) => error as UniplsDroppedError,
    );
    expect(closedErrors).toHaveLength(1);
    expect(rejection).toBe(closedErrors[0]);
    expect(rejection).toMatchObject({ name: "UniplsDroppedError", outcome });
    if (recovery) expect(recovery.cleanupCount).toBe(1);
    expect(scenario.client.lifecycle).toMatchObject({
      phase: "closed",
      reason: "dropped",
      outcome,
      drop: rejection?.drop,
    });
    expect(scenario.client.state).toBe("closed");
    const terminal = scenario.client.lifecycle;
    await scenario.client.close();
    expect(scenario.client.lifecycle).toBe(terminal);

    // A later open creates an unrelated logical session and transport epoch.
    const reopening = scenario.beginOpen();
    const nextConnecting = scenario.client.lifecycle;
    if (nextConnecting.phase !== "connecting" || nextConnecting.status !== "attempting") {
      throw new Error("Expected a new connecting session");
    }
    expect(nextConnecting.session).not.toBe(firstOpen.session);
    scenario.transport.connection(1).emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await reopening;
    const closing = scenario.client.close();
    scenario.transport.connection(1).emitClose({ code: 1000, wasClean: true });
    await closing;
  });
});
