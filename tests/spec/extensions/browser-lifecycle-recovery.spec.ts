import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  BrowserLifecycleDropDetector,
  BrowserLifecycleSource,
  DropReasons,
  type BrowserLifecycleEventTarget,
  type DropDetectorContext,
} from "../../../src/drop-detectors.ts";
import { Unipls, type UniplsDrop } from "../../../src/index.ts";
import {
  BrowserLifecycleReconnector,
  ExponentialBackoffReconnector,
  ImmediateReconnector,
} from "../../../src/reconnectors.ts";
import {
  ControlledReconnector,
  ControlledWebSocketServer,
  flushMicrotasks,
} from "../../support/index.ts";

class BrowserTarget implements BrowserLifecycleEventTarget {
  visibilityState = "visible";
  readonly listeners = new Map<string, Set<(event: { type: string }) => void>>();
  addEventListener(type: string, callback: (event: { type: string }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();

    listeners.add(callback);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, callback: (event: { type: string }) => void): void {
    this.listeners.get(type)?.delete(callback);
  }
  emit(type: string): void {
    const listeners = [...(this.listeners.get(type) ?? [])];

    for (const callback of listeners) {
      callback({ type });
    }
  }
  get listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

function browser() {
  const window = new BrowserTarget();
  const document = new BrowserTarget();
  const navigator = { onLine: true };
  const source = new BrowserLifecycleSource({ window, document, navigator });

  return { window, document, navigator, source };
}

async function open(client: Unipls<string, string>, transport: ControlledWebSocketServer) {
  const opening = client.open();

  transport.current.emitOpen();
  await opening;
}

async function close(client: Unipls<string, string>, transport: ControlledWebSocketServer) {
  const closing = client.close();

  transport.current.emitClose();
  await closing;
}

function createClient(env: ReturnType<typeof browser>, maxRetries?: number) {
  const transport = new ControlledWebSocketServer();
  let sequence = 0;
  const client = new Unipls<string, string>({
    url: "wss://unipls.test/socket",
    WebSocket: transport.WebSocket,
    dropDetectors: [
      new BrowserLifecycleDropDetector({
        source: env.source,
        timeout: 50,
        coalesceDelay: 10,
        createProbe: () => {
          const id = ++sequence;

          return { query: `ping:${id}`, selector: (msg) => msg === `pong:${id}` };
        },
      }),
    ],
    reconnector: new BrowserLifecycleReconnector({
      source: env.source,
      coalesceDelay: 10,
      defaultReconnector: new ExponentialBackoffReconnector({ initialDelay: 100, random: () => 1 }),
      maxRetries,
    }),
  });

  return { client, transport };
}

describe("browser lifecycle recovery", () => {
  afterEach(() => vi.useRealTimers());

  it("復帰イベント群に対して一往復を行い、成功した接続を維持する", async () => {
    vi.useFakeTimers();
    const env = browser();
    const { client, transport } = createClient(env);

    await open(client, transport);
    env.document.emit("resume");
    env.window.emit("pageshow");
    env.document.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.current.sent).toEqual(["ping:1"]);
    transport.current.emitMessage("pong:1");
    await vi.advanceTimersByTimeAsync(100);
    expect(client.lifecycle.phase).toBe("open");
    expect(transport.connections).toHaveLength(1);
    await close(client, transport);
    expect(env.window.listenerCount + env.document.listenerCount).toBe(0);
  });

  it.each(["freeze", "pagehide"])(
    "%s 前の timeout を無効にし、復帰後は新しい応答だけを採用する",
    async (suspend) => {
      vi.useFakeTimers();
      const env = browser();
      const { client, transport } = createClient(env);

      await open(client, transport);
      env.document.visibilityState = "hidden";
      env.document.emit("visibilitychange");
      await vi.advanceTimersByTimeAsync(10);

      if (suspend === "freeze") {
        env.document.emit("freeze");
      } else {
        env.window.emit("pagehide");
      }

      await vi.advanceTimersByTimeAsync(100);
      expect(transport.connections).toHaveLength(1);
      env.document.visibilityState = "visible";
      env.document.emit("resume");
      env.window.emit("pageshow");
      await vi.advanceTimersByTimeAsync(10);
      expect(transport.current.sent).toEqual(["ping:1", "ping:2"]);
      transport.current.emitMessage("pong:1");
      await vi.advanceTimersByTimeAsync(50);
      expect(client.lifecycle.phase).toBe("recovering");
      await vi.advanceTimersByTimeAsync(10);
      expect(transport.connections).toHaveLength(2);
      transport.current.emitOpen();
      await flushMicrotasks();
      env.window.emit("online");
      env.document.emit("resume");
      await vi.advanceTimersByTimeAsync(10);
      transport.current.emitMessage("pong:3");
      await vi.advanceTimersByTimeAsync(200);
      expect(transport.connections).toHaveLength(2);
      expect(client.lifecycle.phase).toBe("open");
      await close(client, transport);
    },
  );

  it("hidden 中の timeout を保留し、visible 時に確認し直す", async () => {
    vi.useFakeTimers();
    const env = browser();
    const { client, transport } = createClient(env);

    await open(client, transport);
    env.document.visibilityState = "hidden";
    env.document.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(100);
    expect(client.lifecycle.phase).toBe("open");
    env.document.visibilityState = "visible";
    env.document.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(10);
    transport.current.emitMessage("pong:2");
    await vi.advanceTimersByTimeAsync(100);
    expect(client.lifecycle.phase).toBe("open");
    await close(client, transport);
  });

  it("lifecycle 起因の初回再試行が失敗したら次の復帰イベントを待つ", async () => {
    vi.useFakeTimers();
    const env = browser();
    const { client, transport } = createClient(env);

    await open(client, transport);
    env.document.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(70);
    expect(transport.connections).toHaveLength(2);
    // 試行中のイベントを次の試行として蓄積しません。
    env.window.emit("online");
    transport.current.emitClose({ code: 4100 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.connections).toHaveLength(2);
    env.document.emit("resume");
    env.window.emit("pageshow");
    env.window.emit("online");
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.connections).toHaveLength(3);
    transport.current.emitOpen();
    await flushMicrotasks();
    expect(client.lifecycle.phase).toBe("open");
    await close(client, transport);
  });

  it("その他の drop は backoff し、休止中は保留して復帰イベントで再開する", async () => {
    vi.useFakeTimers();
    const env = browser();
    const { client, transport } = createClient(env);

    await open(client, transport);
    client.drop();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(99);
    expect(transport.connections).toHaveLength(1);
    env.document.emit("freeze");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.connections).toHaveLength(1);
    env.document.emit("resume");
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.connections).toHaveLength(2);
    transport.current.emitOpen();
    await flushMicrotasks();
    await close(client, transport);
    expect(env.window.listenerCount + env.document.listenerCount).toBe(0);
  });

  it("heartbeat 起因は指数 backoff を使い、close で未実行の再試行を解除する", async () => {
    vi.useFakeTimers();
    const env = browser();
    const transport = new ControlledWebSocketServer();
    let context!: DropDetectorContext<string, string>;
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      dropDetectors: [
        {
          setup(ctx) {
            context = ctx;
          },
        },
      ],
      reconnector: new BrowserLifecycleReconnector({
        source: env.source,
        defaultReconnector: new ExponentialBackoffReconnector({
          initialDelay: 100,
          factor: 2,
          random: () => 1,
        }),
      }),
    });

    await open(client, transport);
    context.drop({ reason: DropReasons.HEARTBEAT_RESPONSE_TIMEOUT });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(99);
    expect(transport.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connections).toHaveLength(2);
    transport.current.emitClose({ code: 4100 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(99);
    expect(transport.connections).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connections).toHaveLength(3);
    transport.current.emitClose({ code: 4100 });
    await flushMicrotasks();
    await close(client, transport);
    await vi.advanceTimersByTimeAsync(10_000);
    env.window.emit("online");
    expect(transport.connections).toHaveLength(3);
    expect(env.window.listenerCount + env.document.listenerCount).toBe(0);
  });

  it("非同期cleanup中もsourceを維持し、復帰した状態で最初の再接続を試す", async () => {
    vi.useFakeTimers();
    const env = browser();
    const transport = new ControlledWebSocketServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      dropDetectors: [
        new BrowserLifecycleDropDetector({
          source: env.source,
          timeout: 50,
          coalesceDelay: 10,
          createProbe: () => ({ query: "ping", selector: (msg) => msg === "pong" }),
        }),
      ],
      reconnector: new BrowserLifecycleReconnector({
        source: env.source,
        coalesceDelay: 10,
        defaultReconnector: new ImmediateReconnector(),
      }),
    });
    const opening = client.open({
      setupConnection(ctx) {
        ctx.defer(() => gate);
      },
    });

    transport.current.emitOpen();
    await opening;
    env.document.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(60);
    expect(transport.connections).toHaveLength(1);
    env.document.emit("freeze");
    env.document.emit("resume");
    release();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    expect(transport.connections).toHaveLength(2);
    transport.current.emitOpen();
    await flushMicrotasks();
    await close(client, transport);
    expect(env.window.listenerCount + env.document.listenerCount).toBe(0);
  });

  it("detector の reason と metadata を固定し、同じ drop を reconnector に渡す", async () => {
    const transport = new ControlledWebSocketServer();
    const reconnector = new ControlledReconnector();
    let context!: DropDetectorContext<string, string>;
    const drops: UniplsDrop[] = [];
    const client = new Unipls<string, string>({
      url: "wss://unipls.test/socket",
      WebSocket: transport.WebSocket,
      reconnector,
      dropDetectors: [
        {
          setup(ctx) {
            context = ctx;
          },
        },
      ],
    });

    client.on("dropped", ({ drop }) => drops.push(drop));
    await open(client, transport);
    expect(() => context.drop({ metadata: { invalid: Number.NaN } })).toThrow(TypeError);
    expect(client.lifecycle.phase).toBe("open");
    const metadata = { detail: { triggers: ["resume"] } };

    context.drop({ reason: DropReasons.BROWSER_LIFECYCLE_PROBE_TIMEOUT, metadata });
    metadata.detail.triggers.push("changed");
    context.drop({ reason: "later" });
    await flushMicrotasks();
    const recovery = reconnector.invocations.take();

    expect(recovery.context.drop).toBe(drops[0]);
    expect(drops[0].source).toMatchObject({
      reason: DropReasons.BROWSER_LIFECYCLE_PROBE_TIMEOUT,
      metadata: { detail: { triggers: ["resume"] } },
    });

    if (drops[0].source.type !== "detector") {
      throw new Error("Expected detector source");
    }

    const detail = drops[0].source.metadata?.detail as { triggers: readonly string[] };

    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail.triggers)).toBe(true);
    await close(client, transport);
  });

  it("lifecycle 戦略にも再試行上限を適用し、終了時にsourceを解放する", async () => {
    vi.useFakeTimers();
    const env = browser();
    const { client, transport } = createClient(env, 1);

    await open(client, transport);
    env.document.emit("visibilitychange");
    await vi.advanceTimersByTimeAsync(70);
    expect(transport.connections).toHaveLength(2);
    transport.current.emitClose({ code: 4100 });
    await flushMicrotasks();
    expect(client.lifecycle.phase).toBe("closed");
    env.window.emit("online");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.connections).toHaveLength(2);
    expect(env.window.listenerCount + env.document.listenerCount).toBe(0);
  });
});
