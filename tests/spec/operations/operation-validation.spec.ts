import { describe, expect, it } from "vite-plus/test";

import { Unipls, UniplsClosedError, UniplsInvalidUsageError } from "../../../src/index.ts";
import { ControlledWebSocketServer, createReadyClient } from "../../support/index.ts";

type TestClient = Unipls<string, string>;

const operationCases = [
  { name: "cast", invoke: (client: TestClient) => client.cast({ query: "cast" }) },
  { name: "next", invoke: (client: TestClient) => client.next({ selector: () => true }) },
  {
    name: "request",
    invoke: (client: TestClient) => client.request({ query: "request", selector: () => true }),
  },
  { name: "listen", invoke: (client: TestClient) => client.listen({}) },
  {
    name: "subscribe",
    invoke: (client: TestClient) => client.subscribe({ query: "subscribe", selector: () => true }),
  },
] as const;

const invalidTimeoutCases = [
  { name: "cast: 0", invoke: (client: TestClient) => client.cast({ query: "cast", timeout: 0 }) },
  {
    name: "next: negative",
    invoke: (client: TestClient) => client.next({ selector: () => true, timeout: -1 }),
  },
  {
    name: "request: NaN",
    invoke: (client: TestClient) =>
      client.request({ query: "request", selector: () => true, timeout: Number.NaN }),
  },
  {
    name: "listen: positive infinity",
    invoke: (client: TestClient) => client.listen({ timeout: Number.POSITIVE_INFINITY }),
  },
  {
    name: "subscribe: negative infinity",
    invoke: (client: TestClient) =>
      client.subscribe({
        query: "subscribe",
        selector: () => true,
        timeout: Number.NEGATIVE_INFINITY,
      }),
  },
] as const;

describe("operation の入力と受付", () => {
  /**
   * ```ts
   * client.next({ selector }); // open() 前なので同期的に UniplsInvalidUsageError
   * await client.open();
   * await client.close();
   * client.cast({ query }); // close() 後なので同期的に UniplsInvalidUsageError
   * ```
   */
  it.each(operationCases)("open intent の外では $name を同期的に拒否する", async ({ invoke }) => {
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });

    expect(() => invoke(client)).toThrow(UniplsInvalidUsageError);

    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const closing = client.close();
    socket.emitClose();
    await closing;

    expect(() => invoke(client)).toThrow(UniplsInvalidUsageError);
  });

  /**
   * ```ts
   * await client.open();
   * const waiting = client.next({ selector }); // active session に受け付けられる
   * const closing = client.close();
   * await waiting; // close() 後に UniplsClosedError で非同期に reject する
   * await closing;
   * ```
   */
  it("受付後の close を同期エラーではなく operation の非同期結果にする", async () => {
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const opening = client.open();
    const socket = transport.current;
    socket.emitOpen();
    await opening;
    const waiting = client.next({ selector: () => false });
    const closing = client.close();
    await expect(waiting).rejects.toBeInstanceOf(UniplsClosedError);
    socket.emitClose();
    await closing;
  });

  /**
   * ```ts
   * await client.open();
   * client.request({ query, selector, timeout: 0 }); // 同期的に RangeError
   * client.listen({ timeout: Number.NaN }); // 同期的に RangeError
   * ```
   */
  it.each(invalidTimeoutCases)(
    "$name は operation 登録前に同期的に拒否する",
    async ({ invoke }) => {
      const { client, close } = await createReadyClient();

      expect(() => invoke(client)).toThrow(RangeError);

      await close();
    },
  );

  /**
   * ```ts
   * // JavaScriptから必須selectorを省略した呼び出し
   * client.request({ query }); // session状態に関係なく同期的にTypeError
   * client.listen({ selector: "topic" }); // callbackではないselectorも同期的にTypeError
   * ```
   */
  it("必須値と入力型の不正を session 確認より先に同期的に拒否する", () => {
    const transport = new ControlledWebSocketServer();
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
    });
    const idle = client.lifecycle;
    const unsafe = client as unknown as {
      cast(params: unknown): unknown;
      next(params: unknown): unknown;
      request(params: unknown): unknown;
      listen(params: unknown): unknown;
      subscribe(params: unknown): unknown;
    };
    const invalidOperations = [
      () => unsafe.cast({}),
      () => unsafe.next({ selector: "response" }),
      () => unsafe.request({ query: "request" }),
      () => unsafe.listen({ selector: "topic" }),
      () => unsafe.subscribe({ selector: () => true }),
    ];
    for (const operation of invalidOperations) {
      expect(operation).toThrow(TypeError);
      expect(operation).not.toThrow(UniplsInvalidUsageError);
    }
    const invalidOptions = [
      () => unsafe.next({ selector: () => true, predicateError: "ignore" }),
      () => unsafe.next({ selector: () => true, retry: "resend" }),
      () => unsafe.request({ query: "request", selector: () => true, retry: {} }),
      () => unsafe.listen({ callbackError: "continue" }),
      () => unsafe.listen({ onMatch: () => {}, buffer: 1 }),
      () => unsafe.subscribe({ query: "subscribe", selector: () => true, signal: {} }),
    ];
    for (const operation of invalidOptions) {
      expect(operation).toThrow(TypeError);
    }
    expect(client.lifecycle).toBe(idle);
    expect(transport.connections).toHaveLength(0);
  });
});
