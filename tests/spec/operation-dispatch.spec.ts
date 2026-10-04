import { describe, expect, it } from "vite-plus/test";

import { Unipls, type UniplsLog } from "../../src/index.ts";
import { ControlledWebSocketServer, flushMicrotasks } from "../support/index.ts";

describe("operation の message dispatch", () => {
  /**
   * ```ts
   * const opening = client.open({
   *   async setupConnection(ctx) {
   *     ctx.listen({ selector: isChallenge, onMatch: consumeChallenge });
   *     await authenticate();
   *   },
   * });
   * const applicationMessage = client.next({ selector: isApplicationMessage });
   * // ! authenticate() の完了前に challenge が WebSocket から届く
   * // consumeChallenge だけが challenge を観測し、applicationMessage の selector は呼ばれない
   * await opening;
   * // ! ready 遷移後に application message が WebSocket から届く
   * await applicationMessage; // ready 後の message だけで解決する
   * ```
   */
  it("provisioning 用と通常 operation の受信経路を ready 境界で分離する", async () => {
    const transport = new ControlledWebSocketServer();
    let finishProvisioning!: () => void;
    const provisioningGate = new Promise<void>((resolve) => {
      finishProvisioning = resolve;
    });
    const provisioningMessages: string[] = [];
    let applicationSelectorCalls = 0;
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const opening = client.open({
      setupConnection: async (context) => {
        context.listen({
          selector: () => true,
          onMatch: (message) => provisioningMessages.push(message),
        });
        await provisioningGate;
      },
    });
    const applicationMessage = client.next({
      selector: (message) => {
        applicationSelectorCalls += 1;
        return message === "application";
      },
    });

    // ! WebSocket が開きますが、provisioner はまだ完了していません。
    const socket = transport.current;
    socket.emitOpen();
    socket.emitMessage("challenge");
    expect(provisioningMessages).toEqual(["challenge"]);
    expect(applicationSelectorCalls).toBe(0);
    finishProvisioning();
    await opening;
    socket.emitMessage("application");
    await expect(applicationMessage).resolves.toBe("application");
    expect(provisioningMessages).toEqual(["challenge"]);
    expect(applicationSelectorCalls).toBe(1);
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const first = client.next({ selector: isPong });
   * const second = client.next({ selector: isPong });
   * // ! 1件の pong が WebSocket から届く
   * await Promise.all([first, second]); // 両方が同じ pong で解決する
   * ```
   */
  it("1件の message を一致する複数の operation へ broadcast する", async () => {
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const first = client.next({ selector: (message) => message === "pong" });
    const second = client.next({ selector: (message) => message === "pong" });

    // ! WebSocket から届く1件を、dispatcher が登録時点の候補すべてへ配送します。
    socket.emitMessage("pong");
    await expect(Promise.all([first, second])).resolves.toEqual(["pong", "pong"]);
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const continued = client.next({ selector: mayThrow });
   * const failed = client.next({ selector: mayThrow, predicateError: "fail" });
   * const independent = client.next({ selector: () => true });
   * // ! mayThrow が例外を投げる message が届く
   * await failed; // 元の例外で reject する
   * await independent; // 同じ message の fan-out は継続する
   * // ! 後続の一致 message が届く
   * await continued; // 既定 policy では後続 message を待ち続ける
   * ```
   */
  it("predicate failure を該当 operation に隔離して policy と診断を適用する", async () => {
    const transport = new ControlledWebSocketServer();
    const diagnostics: UniplsLog[] = [];
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      logSink: (log) => diagnostics.push(log),
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const cause = new Error("predicate failed");
    const mayThrow = (message: string) => {
      if (message === "bad") throw cause;
      return message === "good";
    };
    const continued = client.next({ selector: mayThrow });
    const failed = client.next({ selector: mayThrow, predicateError: "fail" });
    const independent = client.next({ selector: (message) => message === "bad" });

    // ! 最初の message では2件の predicate が失敗しても、3件目まで配送が続きます。
    socket.emitMessage("bad");
    await expect(failed).rejects.toBe(cause);
    await expect(independent).resolves.toBe("bad");

    // ! 次の message で、既定 policy の operation が正常に解決します。
    socket.emitMessage("good");
    await expect(continued).resolves.toBe("good");
    await flushMicrotasks();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((log) => [log.level, log.event, log.context?.policy])).toEqual([
      ["warning", "operation/selection", "continue"],
      ["error", "operation/selection", "fail"],
    ]);
    expect(
      diagnostics.every(
        (log) =>
          log.cause === cause &&
          Object.isFrozen(log) &&
          Object.isFrozen(log.context) &&
          !("connection" in (log.context ?? {})) &&
          !("messageSequence" in (log.context ?? {})),
      ),
    ).toBe(true);
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const response = client.next({ selector: isValidMessage });
   * // ! deserializer が最初の raw message で例外を投げる
   * // connection 情報を含むログが通知され、response は終了しない
   * // ! 次の raw message は正常に変換できる
   * await response; // 正常な後続 message で解決する
   * ```
   */
  it("deserializer failure の message だけを破棄して後続 message を処理する", async () => {
    const transport = new ControlledWebSocketServer();
    const cause = new Error("deserialization failed");
    const diagnostics: UniplsLog[] = [];
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      logSink: (log) => diagnostics.push(log),
      deserializer: (data) => {
        if (data === "bad") throw cause;
        return String(data);
      },
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const response = client.next({ selector: (message) => message === "good" });

    // ! 変換不能な message の後にも、同じ operation は登録されたままです。
    socket.emitMessage("bad");
    socket.emitMessage("good");
    await expect(response).resolves.toBe("good");
    await flushMicrotasks();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      event: "message/deserialization",
      level: "warning",
      cause,
      context: { messageSequence: 1, input: { kind: "text", size: 3 } },
    });
    const lifecycle = client.lifecycle;
    if (lifecycle.phase !== "open") throw new Error("Expected open lifecycle");
    expect(diagnostics[0]?.context?.session).toBe(lifecycle.session);
    expect(diagnostics[0]?.context?.connection).toBe(lifecycle.connection);
    expect(Object.isFrozen(diagnostics[0])).toBe(true);
    expect(Object.isFrozen(diagnostics[0]?.context)).toBe(true);
    const closing = client.close();
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * const factoryCause = new Error("factory");
   * await client.request({
   *   query: () => { throw factoryCause; },
   *   selector,
   * }); // factoryCause そのもので reject する
   * const serializerCause = new Error("serializer");
   * await client.cast({ query }); // serializerCause そのもので reject する
   * ```
   */
  it("message factory と serializer が投げた元の cause を operation 結果に保つ", async () => {
    const transport = new ControlledWebSocketServer();
    let serializerCause: unknown;
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      serializer: (message) => {
        if (serializerCause !== undefined) throw serializerCause;
        return message;
      },
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const factoryCause = new Error("factory failed");
    const requested = client.request({
      query: () => {
        throw factoryCause;
      },
      selector: () => true,
    });
    await expect(requested).rejects.toBe(factoryCause);
    serializerCause = new Error("serializer failed");
    await expect(client.cast({ query: "message" })).rejects.toBe(serializerCause);
    const closing = client.close();
    socket.emitClose();
    await closing;
  });
});
