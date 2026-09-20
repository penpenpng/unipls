// Non-normative historical reference. See README.md; do not treat as a contract test.
import { afterEach, expect, test } from "vitest";
import { Unipls, UniplsTimeoutError } from "../../../src/index.ts";
import { createMockServer, TestProvisioner, timeout, TimeoutError } from "./support";

const url = "ws://localhost:8080";
const server = createMockServer(url);
const query = { query: "ping" };

afterEach(() => {
  server.reset();
});

test("cast() は query を送信する", async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  unipls.cast(query);

  await expect(socket.inbox.dequeue()).resolves.toBe("ping");
});

test("provisioning が完了するまで、cast() は resolve しない", async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  unipls.open(provisioner);
  await server.sockets.dequeue();

  const promise = unipls.cast({
    query: "ping",
  });

  // promise is not resolved yet.
  await expect(timeout(promise, 50)).rejects.toThrow(TimeoutError);

  // Complete provisioning.
  (await provisioner.dequeueContext()).resolve();

  await expect(promise).resolves.toBeUndefined();
});

test("timeout した場合 reject される", async () => {
  const provisioner = new TestProvisioner<string, string>();
  await using unipls = new Unipls<string, string>({ url });

  unipls.open(provisioner);
  await server.sockets.dequeue();
  await provisioner.dequeueContext();

  const promise = unipls.cast({
    query: "ping",
    timeout: 50,
  });

  await expect(promise).rejects.toThrow(UniplsTimeoutError);
});

test("signal が abort されると reject される", async () => {
  const provisioner = new TestProvisioner<string, string>();
  await using unipls = new Unipls<string, string>({ url });

  unipls.open(provisioner);
  await server.sockets.dequeue();
  await provisioner.dequeueContext();

  const controller = new AbortController();
  const promise = unipls.cast({
    query: "ping",
    signal: controller.signal,
  });

  controller.abort(new Error("cancelled"));

  await expect(promise).rejects.toThrow("cancelled");
});

test("query が関数形式の場合、送信時に query は評価される", async () => {
  const provisioner = new TestProvisioner<string, string>();
  await using unipls = new Unipls<string, string>({ url });

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();
  const provisioning = await provisioner.dequeueContext();

  let counter = 0;
  const promise = unipls.cast({
    query: () => `ping-${++counter}`,
  });

  expect(counter).toBe(0);

  provisioning.resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe("ping-1");
  await expect(promise).resolves.toBeUndefined();
  expect(counter).toBe(1);
});
