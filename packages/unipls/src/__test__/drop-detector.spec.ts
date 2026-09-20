import { afterEach, expect, test, vi } from "vitest";
import { ImmediateReconnector, Unipls } from "..";
import { createMockServer, TestDropDetector } from "./test-utils";

const url = "ws://localhost:8080";
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test("Unipls が open() され、provisioning が完了したとき、DropDetector が setup される", async () => {
  const detector = new TestDropDetector();
  await using unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  await server.sockets.dequeue();
  await detector.dequeueContext();

  expect(detector.setupCount).toBe(1);
});

test("Unipls が close() されたとき、DropDetector が cleanup される", async () => {
  const detector = new TestDropDetector();
  await using unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  await server.sockets.dequeue();
  await detector.dequeueContext();

  await unipls.close();

  expect(detector.cleanupCount).toBe(1);
});

test("再接続され、provisioning が完了したとき、DropDetector が setup される", async () => {
  const detector = new TestDropDetector();
  await using unipls = new Unipls({
    url,
    reconnector: new ImmediateReconnector(),
    dropDetectors: [detector],
  });

  await unipls.open();
  await server.sockets.dequeue();
  await detector.dequeueContext();

  expect(detector.setupCount).toBe(1);

  unipls.drop();
  await server.sockets.dequeue();
  await detector.dequeueContext();

  expect(detector.setupCount).toBe(2);
});

test("DropDetector が drop を検出したとき、dropped イベントが発火する", async () => {
  const detector = new TestDropDetector();
  await using unipls = new Unipls({ url, dropDetectors: [detector] });

  const dropped = Promise.withResolvers<void>();
  unipls.on("dropped", () => dropped.resolve(), { once: true });

  await unipls.open();
  await server.sockets.dequeue();
  await detector.dequeueContext();

  detector.drop();

  await expect(dropped.promise).resolves.toBeUndefined();
});

test("同一の接続に対して複数の DropDetector が drop を検出したとしても、dropped イベントは一度だけ発火する", async () => {
  const detector1 = new TestDropDetector();
  const detector2 = new TestDropDetector();
  await using unipls = new Unipls({
    url,
    dropDetectors: [detector1, detector2],
  });

  const spy = vi.fn();
  const dropped = Promise.withResolvers<void>();
  unipls.on("dropped", () => {
    spy();
    dropped.resolve();
  });

  await unipls.open();
  const socket = await server.sockets.dequeue();
  await Promise.all([detector1.dequeueContext(), detector2.dequeueContext()]);

  detector1.drop();
  detector2.drop();

  await Promise.all([dropped.promise, socket.closeEvent.dequeue()]);

  expect(spy).toHaveBeenCalledTimes(1);
});
