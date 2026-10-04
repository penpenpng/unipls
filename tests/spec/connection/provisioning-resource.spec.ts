import { describe, expect, it } from "vite-plus/test";

import type { DropDetectorContext } from "../../../src/drop-detectors.ts";
import {
  Unipls,
  UniplsInvalidUsageError,
  UniplsOpenError,
  type ConnectionSetupContext,
  type SessionSetupContext,
  type StreamFinalization,
  type SubscriptionHandle,
  type UniplsLog,
} from "../../../src/index.ts";
import {
  ControlledReconnector,
  ControlledWebSocketServer,
  flushMicrotasks,
  UniplsRaceScenario,
} from "../../support/index.ts";

describe("provisioning capability と resource scope", () => {
  /**
   * ```ts
   * await client.open({
   *   async setupConnection(ctx) {
   *     await ctx.cast("authenticate");
   *     const subscription = ctx.subscribe({ query: "restore", selector, onMatch: consume });
   *     // ! ready前に応答が届く
   *     await subscription.closed;
   *   },
   * });
   * // setup完了後のctxと高レベルclientからreadiness barrierを迂回できない
   * ```
   */
  it("connection setupだけにraw open後の準備通信capabilityを公開する", async () => {
    // setup完了を制御し、ready前の送受信を観測できるclientを作ります。
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    let context!: ConnectionSetupContext<string, string>;
    let subscription!: SubscriptionHandle<StreamFinalization<string>>;
    const received: string[] = [];
    let requestedResponse: string | undefined;
    let finishSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    let setupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    const opening = client.open({
      setupConnection: async (ctx) => {
        context = ctx;

        await ctx.cast("authenticate");
        const requested = ctx.request({
          query: "current-user",
          selector: (message) => message === "user:alice",
        });

        subscription = ctx.subscribe({
          query: "restore",
          selector: (message) => message === "restored",
          onMatch: (message) => received.push(message),
        });

        setupStarted();

        requestedResponse = await requested;

        await setupGate;
      },
    });

    // ! WebSocketのraw open後、ready遷移前に3種類すべてのqueryを送信します。
    const socket = transport.current;

    socket.emitOpen();
    await started;
    await flushMicrotasks();
    expect(socket.sent).toEqual(["authenticate", "current-user", "restore"]);
    socket.emitMessage("user:alice");
    socket.emitMessage("restored");
    await flushMicrotasks();
    expect(requestedResponse).toBe("user:alice");
    expect(received).toEqual(["restored"]);

    // setup完了時に一時streamを失効させ、保持した全通信capabilityの再利用を拒否します。
    finishSetup();
    await opening;
    const finalization = await subscription.closed;

    expect(finalization).toMatchObject({ ok: false, reason: "aborted" });
    expect(() => context.cast("late")).toThrow(UniplsInvalidUsageError);
    expect(() => context.request({ query: "late", selector: () => true })).toThrow(
      UniplsInvalidUsageError,
    );
    expect(() => context.subscribe({ query: "late", selector: () => true, onMatch() {} })).toThrow(
      UniplsInvalidUsageError,
    );

    // session contextと高レベルclientにはbarrierを迂回するmethodが型として存在しません。
    const sessionHasCast: "cast" extends keyof SessionSetupContext ? true : false = false;
    const clientHasCastForce: "castForce" extends keyof Unipls<string, string> ? true : false =
      false;

    expect(sessionHasCast).toBe(false);
    expect(clientHasCastForce).toBe(false);
    expect("castForce" in client).toBe(false);
    expect("requestForce" in client).toBe(false);
    expect("subscribeForce" in client).toBe(false);

    // ready接続を明示的に終了します。
    const closing = client.close();

    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * await client.open({
   *   setupSession(ctx) {
   *     ctx.defer(disposeSessionListener);
   *   },
   *   setupConnection(ctx) {
   *     ctx.defer(disposeConnectionListener);
   *   },
   * });
   * // ! 接続がdropする
   * // connection resourceだけを解放してからreconnectorを開始する
   * await client.close(); // 最後のconnection、sessionの順で解放する
   * ```
   */
  it("connection resourceをepochごと、session resourceを論理session終了時に解放する", async () => {
    // 最初のconnection disposerだけを保留し、cleanup完了前後を観測します。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const order: string[] = [];
    let sessionSetups = 0;
    let connectionSetups = 0;
    let releaseFirstConnection!: () => void;
    const firstConnectionGate = new Promise<void>((resolve) => {
      releaseFirstConnection = resolve;
    });
    const opening = scenario.client.open({
      setupSession(ctx) {
        sessionSetups += 1;

        ctx.defer(() => {
          order.push("session:defer");
        });

        return () => {
          order.push("session:return");
        };
      },
      setupConnection(ctx) {
        connectionSetups += 1;

        const setupNumber = connectionSetups;

        ctx.defer(() => {
          order.push(`connection-${setupNumber}:defer`);
        });

        if (setupNumber === 1) {
          return async () => {
            order.push("connection-1:return:start");
            await firstConnectionGate;
            order.push("connection-1:return:end");
          };
        }

        return () => {
          order.push("connection-2:return");
        };
      },
    });

    scenario.transport.current.emitOpen();
    await opening;

    // ! dropはconnection cleanupを開始しますが、非同期disposer完了前はreconnectorを呼びません。
    scenario.drop();
    expect(order).toEqual(["connection-1:return:start"]);
    expect(scenario.reconnector.invocations.size).toBe(0);
    expect(sessionSetups).toBe(1);
    releaseFirstConnection();
    await flushMicrotasks();
    expect(order).toEqual([
      "connection-1:return:start",
      "connection-1:return:end",
      "connection-1:defer",
    ]);

    // 同じsessionの代替接続ではconnection setupだけを再実行します。
    scenario.reconnector.invocations.take().reconnect();
    const replacement = scenario.transport.current;

    replacement.emitOpen();
    await scenario.waitForLifecycle(({ phase }) => phase === "open");
    expect(sessionSetups).toBe(1);
    expect(connectionSetups).toBe(2);

    // 明示closeは現在connectionを先に、session resourceを後にLIFOで解放します。
    const closing = scenario.client.close();

    replacement.emitClose();
    await closing;
    expect(order).toEqual([
      "connection-1:return:start",
      "connection-1:return:end",
      "connection-1:defer",
      "connection-2:return",
      "connection-2:defer",
      "session:return",
      "session:defer",
    ]);
  });

  /**
   * ```ts
   * const setupError = new Error("setup failed");
   * await client.open({
   *   setupConnection(ctx) {
   *     ctx.defer(disposeFirst, { name: "first" });
   *     ctx.defer(disposeSecond);
   *     throw setupError;
   *   },
   * });
   * // setupErrorをopen failureのcauseに保ち、cleanup失敗は個別ログにする
   * ```
   */
  it("setup failureでtransactionだけをLIFO rollbackしてcleanup失敗を診断する", async () => {
    // 同期・非同期で失敗するdisposerと元のsetup errorを用意します。
    const transport = new ControlledWebSocketServer();
    const diagnostics: UniplsLog[] = [];
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      logSink: (log) => diagnostics.push(log),
    });
    const setupError = new Error("setup failed");
    const firstCleanupError = new Error("third cleanup failed");
    const secondCleanupError = new Error("second cleanup failed");
    const order: string[] = [];
    const opening = client.open({
      setupConnection(ctx) {
        ctx.defer(
          () => {
            order.push("first");
          },
          { name: "first" },
        );
        ctx.defer(async () => {
          order.push("second:start");
          await Promise.resolve();
          order.push("second:end");
          throw secondCleanupError;
        });
        ctx.defer(
          () => {
            order.push("third");
            throw firstCleanupError;
          },
          { name: "third" },
        );
        throw setupError;
      },
    });

    // ! raw open後のsetup失敗により、全disposerを逆順に試行してからopenを失敗させます。
    transport.current.emitOpen();
    const error = await opening.then(
      () => {
        throw new Error("openが成功しました");
      },
      (cause) => cause as UniplsOpenError,
    );

    expect(error).toBeInstanceOf(UniplsOpenError);
    expect(error.cause).toBe(setupError);
    expect(order).toEqual(["third", "second:start", "second:end", "first"]);
    await flushMicrotasks();
    expect(
      diagnostics.map((log) => ({
        event: log.event,
        cause: log.cause,
        name: log.context?.resourceName,
        source: log.context?.resourceSource,
      })),
    ).toEqual([
      { event: "resource/cleanup", cause: firstCleanupError, name: "third", source: "defer" },
      { event: "resource/cleanup", cause: secondCleanupError, name: undefined, source: "defer" },
    ]);
    expect(
      diagnostics.every(
        (log) =>
          Object.isFrozen(log) &&
          Object.isFrozen(log.context) &&
          !("disposer" in (log.context ?? {})) &&
          !("registrationIndex" in (log.context ?? {})),
      ),
    ).toBe(true);
  });

  /**
   * ```ts
   * await client.open({
   *   setupSession(ctx) {
   *     ctx.defer(rollbackPartialSession);
   *     if (!credentialsAvailable()) throw setupError;
   *   },
   *   setupConnection,
   * });
   * // ! reconnectorがinitial attemptを再試行する
   * // 失敗transactionだけをrollbackし、setupSessionを再実行する
   * ```
   */
  it("失敗したsession setupをrollbackして次のinitial attemptで再実行する", async () => {
    // 最初だけ失敗するsession setupと、成功後まで残るsession resourceを作ります。
    const scenario = new UniplsRaceScenario({ detectorCount: 0 });
    const cause = new Error("session setup failed");
    let sessionSetups = 0;
    let connectionSetups = 0;
    let rollbackCount = 0;
    let finalCleanupCount = 0;
    const opening = scenario.client.open({
      setupSession(ctx) {
        sessionSetups += 1;

        if (sessionSetups === 1) {
          ctx.defer(() => {
            rollbackCount += 1;
          });
          throw cause;
        }

        ctx.defer(() => {
          finalCleanupCount += 1;
        });
      },
      setupConnection() {
        connectionSetups += 1;
      },
    });

    // ! 最初のsession transactionをrollbackしてからreconnectorへ失敗を渡します。
    scenario.transport.current.emitOpen();
    await flushMicrotasks();
    expect(rollbackCount).toBe(1);
    const retry = scenario.reconnector.invocations.take();

    expect(retry.context.cause).toBe(cause);

    // 次のattemptではsession setupを改めて成功させ、その後connection setupを実行します。
    retry.reconnect();
    const replacement = scenario.transport.current;

    replacement.emitOpen();
    await opening;

    expect(sessionSetups).toBe(2);
    expect(connectionSetups).toBe(1);
    expect(rollbackCount).toBe(1);

    // session終了時に成功したtransactionのresourceだけを破棄します。
    const closing = scenario.client.close();

    replacement.emitClose();
    await closing;
    expect(finalCleanupCount).toBe(1);
  });

  /**
   * ```ts
   * await client.open({ setupConnection });
   * // ! 1つ目のdrop detector setup後、2つ目のsetupが失敗する
   * // detectorとconnection setup resourceを同じtransactionでrollbackする
   * ```
   */
  it("drop detector setup failureをconnection setup failureとしてrollbackする", async () => {
    // 2つ目で失敗するdetectorと、それ以前のresourceのcleanup順を記録します。
    const transport = new ControlledWebSocketServer();
    const reconnector = new ControlledReconnector();
    const cause = new Error("detector setup failed");
    const order: string[] = [];
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      reconnector,
      dropDetectors: [
        {
          name: "first",
          setup() {
            order.push("detector:first:setup");

            return () => {
              order.push("detector:first:cleanup");
            };
          },
        },
        {
          name: "second",
          setup(ctx) {
            order.push("detector:second:setup");
            ctx.defer(() => {
              order.push("detector:second:partial-cleanup");
            });
            throw cause;
          },
        },
      ],
    });
    const opening = client.open({
      setupConnection(ctx) {
        ctx.defer(() => {
          order.push("connection:cleanup");
        });
      },
    });

    // ! detector failure後、先に登録されたdetector、connection resourceの順にrollbackします。
    transport.current.emitOpen();
    const retry = await reconnector.invocations.next();

    expect(retry.context.cause).toBe(cause);
    retry.cancel();
    const error = await opening.then(
      () => {
        throw new Error("openが成功しました");
      },
      (failure) => failure as UniplsOpenError,
    );

    expect(error.cause).toBe(cause);
    expect(order).toEqual([
      "detector:first:setup",
      "detector:second:setup",
      "detector:second:partial-cleanup",
      "detector:first:cleanup",
      "connection:cleanup",
    ]);
  });

  /**
   * ```ts
   * const detector = {
   *   setup(ctx) {
   *     host.onEvent(ctx.guard(mayThrow));
   *     ctx.run(backgroundTask);
   *   },
   * };
   * // ! 監督対象callbackまたはtaskが失敗する
   * // detectorだけを停止し、connectionは継続する
   * ```
   */
  it.each([
    ["guard", "同期throw", "sync"],
    ["guard", "非同期reject", "async"],
    ["run", "同期throw", "sync"],
    ["run", "非同期reject", "async"],
  ] as const)(
    "drop detectorの%sで%sを当該detectorへ隔離する",
    async (boundary, _failureLabel, failureMode) => {
      // detector contextの監督境界を後から発火できるよう保持します。
      const transport = new ControlledWebSocketServer();
      const reconnector = new ControlledReconnector();
      const cause = new Error(`${boundary} failed`);
      const fail = () => {
        if (failureMode === "sync") {
          throw cause;
        }

        return Promise.reject(cause);
      };
      const diagnostics: UniplsLog[] = [];
      let trigger!: () => void;
      let survivorDrop!: () => void;
      let detectorSignal!: AbortSignal;
      let survivorSignal!: AbortSignal;
      let detectorIdentity!: object;
      let cleanupCount = 0;
      let survivorCleanupCount = 0;
      const client = new Unipls<string, string>({
        url: "wss://unipls.test/socket",
        WebSocket: transport.WebSocket,
        reconnector,
        logSink: (log) => diagnostics.push(log),
        dropDetectors: [
          {
            name: "supervised",
            setup(ctx: DropDetectorContext<string, string>) {
              detectorSignal = ctx.signal;
              detectorIdentity = ctx.detector;

              ctx.defer(() => {
                cleanupCount += 1;
              });

              trigger = boundary === "guard" ? ctx.guard(fail) : () => ctx.run(fail);
            },
          },
          {
            name: "survivor",
            setup(ctx) {
              survivorSignal = ctx.signal;
              survivorDrop = ctx.drop;

              return () => {
                survivorCleanupCount += 1;
              };
            },
          },
        ],
      });
      const opening = client.open({ setupConnection() {} });
      const socket = transport.current;

      socket.emitOpen();
      await opening;

      // ! runtime failureはdetector scopeだけをabort・cleanupして診断します。
      expect(trigger).not.toThrow();
      trigger();
      await flushMicrotasks();
      expect(detectorSignal.aborted).toBe(true);
      expect(survivorSignal.aborted).toBe(false);
      expect(cleanupCount).toBe(1);
      expect(survivorCleanupCount).toBe(0);
      expect(client.lifecycle.phase).toBe("open");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        event: "resilience/drop-detection",
        level: "warning",
        cause,
        context: { boundary, detector: { registrationIndex: 0, name: "supervised" } },
      });
      expect(diagnostics[0]?.context?.detector).toBe(detectorIdentity);
      expect(Object.isFrozen(diagnostics[0])).toBe(true);
      expect(Object.isFrozen(diagnostics[0]?.context)).toBe(true);
      expect(Object.isFrozen(diagnostics[0]?.context?.detector)).toBe(true);

      // 生存しているdetectorは引き続き同じconnectionを監視し、dropを報告できます。
      survivorDrop();
      const recovery = reconnector.invocations.take();

      expect(cleanupCount).toBe(1);
      expect(survivorCleanupCount).toBe(1);
      expect(diagnostics).toHaveLength(1);
      recovery.cancel();
    },
  );
});
