import { afterEach, expect, test, vi } from 'vitest';
import { Unipls } from '..';
import {
  AwaitableQueue,
  createMockServer,
  immediateReconnector,
  TestDropDetector,
} from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test('open() 完了後に setup() が呼ばれる', async () => {
  const detector = new TestDropDetector();
  const unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  await server.sockets.dequeue();

  expect(detector.setupCount).toBe(1);

  await unipls.close();
});

test('ctx.drop() を呼ぶと dropped イベントが発生する', async () => {
  const detector = new TestDropDetector();
  const drops = new AwaitableQueue<void>();
  const unipls = new Unipls({ url, dropDetectors: [detector] });

  unipls.on('dropped', () => drops.enqueue());

  await unipls.open();
  await server.sockets.dequeue();

  detector.drop();

  await expect(drops.dequeue()).resolves.toBeUndefined();

  await unipls.close();
});

test('切断時に dispose が呼ばれる', async () => {
  const detector = new TestDropDetector();
  const unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  socket.close(3001);

  await vi.waitFor(() => {
    expect(detector.cleanupCount).toBe(1);
  });

  await unipls.close();
});

test('close() 時に dispose が呼ばれる', async () => {
  const detector = new TestDropDetector();
  const unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  await server.sockets.dequeue();

  await unipls.close();

  expect(detector.cleanupCount).toBe(1);
});

test('再接続後に setup() が再度呼ばれる', async () => {
  const detector = new TestDropDetector();
  const unipls = new Unipls({
    url,
    reconnector: immediateReconnector,
    dropDetectors: [detector],
  });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  socket.close(3001);

  await server.sockets.dequeue();

  await vi.waitFor(() => {
    expect(detector.setupCount).toBe(2);
  });

  await unipls.close();
});
