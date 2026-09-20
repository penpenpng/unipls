import { describe, expect, it, vi } from "vite-plus/test";

import {
  Unipls,
  UniplsBufferOverflowError,
  UniplsClosedError,
  UniplsDroppedError,
  UniplsInvalidUsageError,
  UniplsOpenError,
  UniplsTimeoutError,
  type ConnectionAttemptSnapshot,
  type ConnectionId,
  type SessionId,
  type UniplsDiagnostic,
  type UniplsDrop,
} from "../../src/index.ts";
import {
  ControlledWebSocketServer,
  flushMicrotasks,
  UniplsRaceScenario,
} from "../support/index.ts";

describe("public event、error、diagnostic", () => {
  /**
   * ```ts
   * client.on("open", (event) => observe(event));
   * client.on("message", (event) => consume(event.message));
   * client.on("unknown", () => {}); // 型エラー
   * // 公開eventを書き換えてもclient.lifecycleは変更されない
   * ```
   */
  it("有限event名だけを受け付けて公開payloadを不変にする", async () => {
    // 各lifecycle段階の公開eventを保存できるclientを開きます。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const opened: object[] = [];
    const messages: object[] = [];
    const dropped: object[] = [];
    const closed: object[] = [];
    const lifecycleEvents: object[] = [];
    scenario.client.on("open", (event) => opened.push(event));
    scenario.client.on("message", (event) => messages.push(event));
    scenario.client.on("dropped", (event) => dropped.push(event));
    scenario.client.on("closed", (event) => closed.push(event));
    scenario.client.on("lifecycle", (event) => lifecycleEvents.push(event));
    const rejectUnknownEventAtCompileTime = () => {
      // @ts-expect-error 存在しないevent名は公開型で拒否されます。
      scenario.client.on("unknown", () => {});
    };
    void rejectUnknownEventAtCompileTime;
    const opening = scenario.beginOpen();
    const socket = scenario.transport.current;
    socket.emitOpen();
    scenario.provisioner.succeed(scenario.provisioner.invocations.take());
    await opening;

    // ready eventの書き換えを拒否し、内部snapshotとの分離を維持します。
    const openSnapshot = scenario.client.lifecycle;
    expect(() => Object.assign(opened[0] as object, { session: "tampered" })).toThrow(TypeError);
    expect(scenario.client.lifecycle).toBe(openSnapshot);
    socket.emitMessage("message");

    // ! 接続dropとreconnectorのcancelによりdrop、closed eventを順に確定します。
    scenario.drop();
    scenario.reconnector.invocations.take().cancel();
    expect(opened).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(lifecycleEvents.length).toBeGreaterThan(0);
    expect(
      [...opened, ...messages, ...dropped, ...closed, ...lifecycleEvents].every((event) =>
        Object.isFrozen(event),
      ),
    ).toBe(true);
  });

  /**
   * ```ts
   * if (error instanceof UniplsOpenError) {
   *   inspect(error.outcome, error.attempts, error.cause);
   * }
   * if (error instanceof UniplsDroppedError) {
   *   inspect(error.outcome, error.drop, error.cause);
   * }
   * // metadataは生成後に変更できない
   * ```
   */
  it("6種類のdomain errorへ安定したnameと不変metadataを与える", () => {
    // 外部由来の可変metadataからopen/drop errorを構築します。
    const session = "session-test" as SessionId;
    const connection = "connection-test" as ConnectionId;
    const cause = new Error("terminal cause");
    const drop: UniplsDrop = {
      source: { type: "peer-close" },
      session,
      connection,
      detectedAt: 1,
      close: { code: 4100, reason: "closed", wasClean: false },
      cause,
    };
    const attempts: ConnectionAttemptSnapshot[] = [
      {
        sequence: 1,
        cycle: 0,
        attempt: 1,
        origin: "initial",
        connection,
        startedAt: 1,
        endedAt: 2,
        outcome: "failed",
        stage: "connecting",
        cause,
        drop,
      },
    ];
    const openError = new UniplsOpenError({
      outcome: "attempt-failed",
      stage: "connecting",
      attempts,
      cause,
      drop,
    });
    const droppedError = new UniplsDroppedError({
      outcome: "recovery-exhausted",
      attempts,
      cause,
      drop,
    });
    const errors = [
      new UniplsInvalidUsageError("invalid usage"),
      openError,
      new UniplsClosedError(),
      droppedError,
      new UniplsTimeoutError(),
      new UniplsBufferOverflowError(),
    ];

    // 各errorはprototypeとclass固有nameを保ち、公開metadataも凍結されています。
    expect(errors.map((error) => error.name)).toEqual([
      "UniplsInvalidUsageError",
      "UniplsOpenError",
      "UniplsClosedError",
      "UniplsDroppedError",
      "UniplsTimeoutError",
      "UniplsBufferOverflowError",
    ]);
    expect(errors.every((error) => error instanceof Error && Object.isFrozen(error))).toBe(true);
    expect(openError.cause).toBe(cause);
    expect(droppedError.cause).toBe(cause);
    expect(Object.isFrozen(openError.attempts)).toBe(true);
    expect(Object.isFrozen(openError.attempts[0])).toBe(true);
    expect(Object.isFrozen(openError.drop)).toBe(true);
    expect(Object.isFrozen(openError.drop?.source)).toBe(true);
    expect(Object.isFrozen(openError.drop?.close)).toBe(true);

    // 元の配列や入れ子metadataを変更してもerrorが保持するsnapshotは変わりません。
    attempts.push({ ...attempts[0], sequence: 2 });
    Object.assign(attempts[0], { sequence: 99 });
    Object.assign(drop.close ?? {}, { code: 4200 });
    expect(openError.attempts).toHaveLength(1);
    expect(openError.attempts[0]?.sequence).toBe(1);
    expect(openError.drop?.close?.code).toBe(4100);
    expect(droppedError.attempts).toHaveLength(1);
  });

  /**
   * ```ts
   * client.on("diagnostic", () => { throw observerError; });
   * client.on("diagnostic", collectDiagnostic);
   * const response = client.next({ selector });
   * // ! deserializerがraw messageで失敗する
   * // message破棄の確定後、次のmicrotaskで全observerを相互に隔離して通知する
   * ```
   */
  it("diagnosticをmicrotaskで隔離fan-outしconsoleへ出力しない", async () => {
    // 最初のobserverだけが失敗する診断経路と、後続messageを待つoperationを作ります。
    const transport = new ControlledWebSocketServer();
    const cause = new Error("deserialization failed");
    const observerCause = new Error("diagnostic observer failed");
    const diagnostics: UniplsDiagnostic[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      deserializer(data) {
        if (data === "bad") throw cause;
        return String(data);
      },
    });
    client.on("diagnostic", () => {
      throw observerCause;
    });
    client.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const response = client.next({ selector: (message) => message === "good" });

    // ! 変換失敗は同期処理へ逆流せず、diagnosticはまだ配送されません。
    expect(() => socket.emitMessage("bad")).not.toThrow();
    expect(diagnostics).toEqual([]);
    socket.emitMessage("good");
    await expect(response).resolves.toBe("good");
    await flushMicrotasks();

    // 先行observerのthrow後も同じ不変snapshotを後続observerへ配送します。
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      type: "message-deserialization-failed",
      cause,
      input: { kind: "text", size: 3 },
    });
    expect(Object.isFrozen(diagnostics[0])).toBe(true);
    if (diagnostics[0]?.type !== "message-deserialization-failed") {
      throw new Error("deserialization diagnosticがありません");
    }
    expect(Object.isFrozen(diagnostics[0].scope)).toBe(true);
    expect(Object.isFrozen(diagnostics[0].input)).toBe(true);
    expect("message" in diagnostics[0]).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    const closing = client.close();
    socket.emitClose();
    await closing;
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });
});
