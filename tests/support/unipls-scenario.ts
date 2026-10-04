import { Unipls, type UniplsLifecycleSnapshot, type UniplsLog } from "../../src/index.ts";
import {
  ControlledWebSocketServer,
  type ControlledCloseEventInit,
} from "./controlled-websocket.ts";
import {
  ControlledDropDetector,
  ControlledProvisioner,
  ControlledReconnector,
  type ControlledReconnectorInvocation,
} from "./controllers.ts";

export type RaceWinner = "close" | "reconnect";

export class UniplsRaceScenario {
  readonly transport = new ControlledWebSocketServer();
  readonly provisioner = new ControlledProvisioner();
  readonly reconnector = new ControlledReconnector();
  readonly detectors: ControlledDropDetector[];
  readonly client: Unipls<string, string>;
  readonly logs: UniplsLog[] = [];

  constructor({
    detectorCount = 2,
    reconnectable = true,
  }: { detectorCount?: number; reconnectable?: boolean } = {}) {
    this.detectors = Array.from(
      { length: detectorCount },
      (_, index) => new ControlledDropDetector(`detector-${index}`),
    );
    this.client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: this.transport.WebSocket,
      ...(reconnectable ? { reconnector: this.reconnector } : {}),
      dropDetectors: this.detectors,
      logSink: (log) => this.logs.push(log),
    });
  }

  beginOpen(): Promise<void> {
    return this.client.open(this.provisioner);
  }

  waitForLifecycle(
    predicate: (snapshot: UniplsLifecycleSnapshot) => boolean,
  ): Promise<UniplsLifecycleSnapshot> {
    const current = this.client.lifecycle;
    if (predicate(current)) {
      return Promise.resolve(current);
    }

    return new Promise((resolve) => {
      const stop = this.client.on("lifecycle", ({ current: next }) => {
        if (!predicate(next)) {
          return;
        }
        stop();
        resolve(next);
      });
    });
  }

  attemptSecondOpen(): Promise<void> {
    return this.client.open(this.provisioner);
  }

  emitStaleOpen(connection: number): void {
    this.transport.connection(connection).emitOpen();
  }

  emitStaleMessage(connection: number, message: string): void {
    this.transport.connection(connection).emitMessage(message);
  }

  emitStaleClose(connection: number, init?: ControlledCloseEventInit): void {
    this.transport.connection(connection).emitClose(init);
  }

  drop(connection = this.transport.connections.length - 1): void {
    this.transport.connection(connection).emitClose({ code: 3001, wasClean: false });
  }

  raceCloseAndReconnect(
    invocation: ControlledReconnectorInvocation,
    winner: RaceWinner,
  ): Promise<void> {
    if (winner === "close") {
      const closing = this.client.close();
      invocation.reconnect();
      return closing;
    }

    invocation.reconnect();
    return this.client.close();
  }
}
