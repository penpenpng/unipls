// Non-normative historical reference. See README.md; do not treat as a contract test.
import { afterEach, expect, test } from "vitest";
import { Unipls, UniplsClosedError } from "../../../src/index.ts";
import { createMockServer, TestProvisioner, timeout, TimeoutError } from "./support";

const url = "ws://localhost:8080";
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test("open インテント中の送信は、必要であればバッファリングされる", async () => {
  const provisioner = new TestProvisioner<string, string>();
  await using unipls = new Unipls<string, string>({ url });

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();
  const provisioning = await provisioner.dequeueContext();

  const promise = unipls.cast({
    query: "ping",
  });

  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(timeout(promise, 50)).rejects.toThrow(TimeoutError);

  provisioning.resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe("ping");
  await expect(promise).resolves.toBeUndefined();
});

test("open インテント中にバッファされた送信は、close インテントに遷移したときに破棄される", async () => {
  const provisioner = new TestProvisioner<string, string>();
  await using unipls = new Unipls<string, string>({ url });

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();
  await provisioner.dequeueContext();

  const promise = unipls.cast({
    query: "ping",
  });

  await unipls.close();
  await unipls.open();

  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(promise).rejects.toThrow(UniplsClosedError);
});

test("close インテント中に送信することはできない", async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  await server.sockets.dequeue();
  await unipls.close();

  expect(() =>
    unipls.cast({
      query: "ping",
    }),
  ).toThrow(UniplsClosedError);
});
