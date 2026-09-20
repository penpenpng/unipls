// Non-normative historical reference. See README.md; do not treat as a contract test.
import { afterEach, expect, test } from "vitest";
import {
  ImmediateReconnector,
  Unipls,
  UniplsClosedError,
  UniplsDroppedError,
  UniplsTimeoutError,
  type WebSocketData,
} from "../../../src/index.ts";
import { createMockServer, TestProvisioner, TestSubscriber } from "./support";

const url = "ws://localhost:8080";
const server = createMockServer(url);
const query = {
  query: "ping",
  selector: (msg: WebSocketData) => typeof msg === "string" && msg.startsWith("pong-"),
};

afterEach(() => {
  server.reset();
});

test("subscribe() は query を送信した後、selector に合致するメッセージを監視する", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
  });
  socket.send("pong-1");
  socket.send("ignored");
  socket.send("pong-2");

  await expect(socket.inbox.dequeue()).resolves.toBe("ping");
  await expect(sub.messages.dequeue()).resolves.toBe("pong-1");
  await expect(sub.messages.dequeue()).resolves.toBe("pong-2");
});

test("query を送信するよりも前に受け取ったメッセージは無視される", async () => {
  const provisioner = new TestProvisioner<string, string>();
  await using unipls = new Unipls<string, string>({ url });

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();
  const provisioning = await provisioner.dequeueContext();

  const sub = new TestSubscriber<string>();
  unipls.subscribe({
    ...sub,
    ...query,
  });

  socket.send("pong-1");

  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();

  provisioning.resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe("ping");

  socket.send("pong-1");
  await expect(sub.messages.dequeue()).resolves.toBe("pong-1");
});

test("terminator オプションがメッセージの終端を定義する", async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    terminator: (msg) => msg === "stop",
  });

  socket.send("pong-1");
  socket.send("pong-2");
  socket.send("stop");
  socket.send("ignored");

  await expect(sub.messages.dequeue()).resolves.toBe("pong-1");
  await expect(sub.messages.dequeue()).resolves.toBe("pong-2");
  await expect(sub.termination).resolves.toBe("stop");
  await expect(sub.finalization).resolves.toMatchObject({
    reason: "terminated",
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test("unsubscribe によって onUnsubscribed と finally がトリガーされる", async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  const unsubscribe = unipls.subscribe({
    ...sub,
    ...query,
  });

  socket.send("pong-1");
  socket.send("pong-2");

  await expect(sub.messages.dequeue()).resolves.toBe("pong-1");
  await expect(sub.messages.dequeue()).resolves.toBe("pong-2");

  unsubscribe();
  socket.send("pong-3");

  await expect(sub.unsubscription).resolves.toBeUndefined();
  await expect(sub.finalization).resolves.toMatchObject({
    reason: "unsubscribed",
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test("Unipls を close() すると onFatalError がトリガーされる", async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
  });

  socket.send("pong-1");
  socket.send("pong-2");

  await expect(sub.messages.dequeue()).resolves.toBe("pong-1");
  await expect(sub.messages.dequeue()).resolves.toBe("pong-2");

  unipls.close();
  socket.send("pong-3");

  await expect(sub.termination).rejects.toThrow(UniplsClosedError);
  await expect(sub.finalization).resolves.toMatchObject({
    reason: "closed",
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test("timeout した場合、onFatalError がトリガーされる", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    timeout: 50,
  });

  await expect(socket.inbox.dequeue()).resolves.toBe("ping");
  await expect(sub.termination).rejects.toThrow(UniplsTimeoutError);
  await expect(sub.finalization).resolves.toMatchObject({
    reason: "fatal-error",
  });
});

test("signal が abort されると reason: aborted で onFatalError がトリガーされる", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const sub = new TestSubscriber();
  const controller = new AbortController();
  unipls.subscribe({
    ...sub,
    ...query,
    signal: controller.signal,
  });

  controller.abort(new Error("cancelled"));

  await expect(sub.termination).rejects.toThrow("cancelled");
  await expect(sub.finalization).resolves.toMatchObject({
    reason: "aborted",
  });
});

test("close() 時に UniplsClosedError で reason: closed で onFatalError がトリガーされる", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
  });

  unipls.close();

  await expect(sub.termination).rejects.toThrow(UniplsClosedError);
  await expect(sub.finalization).resolves.toMatchObject({
    reason: "closed",
  });
});

test("reconnector が与えられていない場合、drop 時に reason: dropped で onFatalError がトリガーされる", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
  });

  unipls.drop();

  await expect(sub.termination).rejects.toThrow(UniplsDroppedError);
  await expect(sub.finalization).resolves.toMatchObject({
    reason: "dropped",
  });
});

test("reconnector が与えられていて、リトライ戦略に wait が指定されている場合、再接続後に query の再送は行われないが、レスポンスの待機は継続する", async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    retry: "wait",
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send("pong-1");

  await expect(socket1.inbox.dequeue()).resolves.toBe("ping");
  await expect(socket2.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(sub.messages.dequeue()).resolves.toBe("pong-1");
});

test("reconnector が与えられていて、リトライ戦略に resend が指定されている場合、再接続後に query の再送が行われ、レスポンスの待機も継続する", async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    retry: "resend",
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send("pong-1");

  await expect(socket1.inbox.dequeue()).resolves.toBe("ping");
  await expect(socket2.inbox.dequeue()).resolves.toBe("ping");
  await expect(sub.messages.dequeue()).resolves.toBe("pong-1");
});

test("reconnector が与えられていて、リトライ戦略に fail が指定されている場合、drop 時に reason: dropped で onFatalError がトリガーされる", async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    retry: "fail",
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send("pong");

  await expect(socket1.inbox.dequeue()).resolves.toBe("ping");
  await expect(socket2.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(sub.termination).rejects.toThrow(UniplsDroppedError);
});

test("query が関数形式の場合、再送時に query は再評価される", async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls<string, string>({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  let counter = 0;
  const sub = new TestSubscriber<string>();
  unipls.subscribe({
    ...sub,
    query: () => `ping-${++counter}`,
    selector: (msg) => msg.startsWith("pong-"),
    retry: "resend",
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  await expect(socket1.inbox.dequeue()).resolves.toBe("ping-1");
  await expect(socket2.inbox.dequeue()).resolves.toBe("ping-2");

  socket2.send("pong-1");

  await expect(sub.messages.dequeue()).resolves.toBe("pong-1");
});

test("custom retry strategy は recover() によって再接続後の query と selector を独自に切り替えられる", async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls<string, string>({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const sub = new TestSubscriber<string>();
  unipls.subscribe({
    ...sub,
    query: "ping-1",
    selector: (msg) => msg === "pong-1",
    retry: {
      recover: () => ({
        query: "ping-2",
        selector: (msg) => msg === "pong-2",
      }),
    },
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  await expect(socket1.inbox.dequeue()).resolves.toBe("ping-1");
  await expect(socket2.inbox.dequeue()).resolves.toBe("ping-2");

  socket2.send("pong-1");
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();

  socket2.send("pong-2");
  await expect(sub.messages.dequeue()).resolves.toBe("pong-2");
});
