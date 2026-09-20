// Non-normative historical reference. See README.md; do not treat as a contract test.
import { afterEach, expect, test } from "vitest";
import { ImmediateReconnector, Unipls, UniplsClosedError } from "../../../src/index.ts";
import {
  createMockServer,
  TestProvisioner,
  TestSubscriber,
  timeout,
  TimeoutError,
} from "./support";

const url = "ws://localhost:8080";
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test("初回接続後、Provisioning が完了するまで open() の解決は保留される", async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  const promise = unipls.open(provisioner);
  await server.sockets.dequeue();

  await expect(timeout(promise, 50)).rejects.toThrow(TimeoutError);

  // Complete provisioning manually.
  (await provisioner.dequeueContext()).resolve();

  await expect(promise).resolves.toBeUndefined();
});

test("初回接続後、Provisioning が失敗した場合、open() の結果は reject される", async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  const promise = unipls.open(provisioner);
  await server.sockets.dequeue();

  // Fail provisioning manually.
  const ERROR = Symbol();
  (await provisioner.dequeueContext()).reject(ERROR);

  await expect(promise).rejects.toBe(ERROR);
});

test("初回接続後、Provisioning が完了する前に close() された場合、open() の結果は reject される", async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  const promise = unipls.open(provisioner);
  await server.sockets.dequeue();

  unipls.close();

  await expect(promise).rejects.toThrow(UniplsClosedError);
});

test("初回接続後、Provisioning が完了するまで cast() の送信は保留される", async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();

  unipls.cast({
    query: "ping",
  });

  // 'ping' is not sent because provisioner is not settled yet.
  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrow();

  // Complete provisioning manually.
  (await provisioner.dequeueContext()).resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe("ping");
});

test("初回接続後、Provisioning が完了するまで request() の送信は保留される", async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();

  unipls.request({
    query: "ping",
    selector: (msg) => msg === "pong",
  });

  // 'ping' is not sent because provisioner is not settled yet.
  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrow();

  // Complete provisioning manually.
  (await provisioner.dequeueContext()).resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe("ping");
});

test("初回接続後、Provisioning が完了するまで subscribe() の送信は保留される", async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    query: "ping",
    selector: (msg) => msg === "pong",
  });

  // 'ping' is not sent because provisioner is not settled yet.
  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrow();

  // Complete provisioning manually.
  (await provisioner.dequeueContext()).resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe("ping");
});

test("再接続後、Provisioning が完了するまで request() の送信は保留される", async () => {
  const provisioner = new TestProvisioner<string, string>();
  await using unipls = new Unipls<string, string>({
    url,
    reconnector: new ImmediateReconnector(),
  });

  const openPromise = unipls.open(provisioner);
  await server.sockets.dequeue();

  (await provisioner.dequeueContext()).resolve();
  await openPromise;

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  const response = unipls.request({
    query: "ping",
    selector: (msg) => msg === "pong",
  });

  await expect(socket2.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(timeout(response, 50)).rejects.toThrow(TimeoutError);

  const secondProvisioning = await provisioner.dequeueContext();
  secondProvisioning.resolve();

  await expect(socket2.inbox.dequeue()).resolves.toBe("ping");
});

test("Provisioning の中で通信関数を呼び出すことができる", async () => {
  await using unipls = new Unipls<string, string>({ url });

  const openPromise = unipls.open(async (ctx) => {
    await ctx.cast("auth");
    await expect(
      ctx.request({
        query: "ping",
        selector: (msg) => msg === "pong",
      }),
    ).resolves.toBe("pong");
  });

  const socket = await server.sockets.dequeue();

  await expect(socket.inbox.dequeue()).resolves.toBe("auth");
  await expect(socket.inbox.dequeue()).resolves.toBe("ping");

  socket.send("pong");

  await expect(openPromise).resolves.toBeUndefined();
});
