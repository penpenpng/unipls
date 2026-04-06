import { afterEach, expect, test } from "vitest";
import { Unipls } from "..";
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

  expect(detector.setupCount).toBe(1);
});

test("Unipls が close() されたとき、DropDetector が cleanup される", async () => {
  const detector = new TestDropDetector();
  await using unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  await server.sockets.dequeue();

  expect(detector.setupCount).toBe(1);

  await unipls.close();

  expect(detector.cleanupCount).toBe(1);
});

test("再接続され、provisioning が完了したとき、DropDetector が setup される", async () => {
  const detector = new TestDropDetector();
  await using unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  await server.sockets.dequeue();

  expect(detector.setupCount).toBe(1);
});

test("DropDetector が drop を検出したとき、dropped イベントが発火する", async () => {
  const detector = new TestDropDetector();
  await using unipls = new Unipls({ url, dropDetectors: [detector] });

  const dropped = Promise.withResolvers<void>();
  const off = unipls.on("dropped", () => {
    dropped.resolve();
  });

  await unipls.open();
  await server.sockets.dequeue();

  detector.drop();

  await expect(dropped.promise).resolves.toBeUndefined();

  off();
});

test("同一の接続に対して複数の DropDetector が drop を検出したとしても、dropped イベントは一度だけ発火する", async () => {
  const detector1 = new TestDropDetector();
  const detector2 = new TestDropDetector();
  await using unipls = new Unipls({
    url,
    dropDetectors: [detector1, detector2],
  });

  let droppedCount = 0;
  const off = unipls.on("dropped", () => {
    droppedCount += 1;
  });

  await unipls.open();
  await server.sockets.dequeue();

  detector1.drop();
  detector2.drop();

  await expect
    .poll(() => droppedCount, {
      timeout: 100,
    })
    .toBe(1);

  off();
});
