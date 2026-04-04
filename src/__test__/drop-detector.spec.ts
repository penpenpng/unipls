import { afterEach, expect, test } from 'vitest';
import { Unipls, type UniplsReconnector } from '..';
import {
  AwaitableQueue,
  createMockServer,
  ManualDropDetector,
} from './test-utils';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

const alwaysReconnect: UniplsReconnector = { reconnect: () => true };

afterEach(() => {
  mock.reset();
});

test('open() 完了後に setup() が呼ばれる', async () => {
  const detector = new ManualDropDetector();
  const unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  await mock.sockets.dequeue();

  // open() 完了時点で setup() は既に呼ばれているので即 resolve する
  await expect(detector.setups.dequeue()).resolves.toBeDefined();

  await unipls.close();
});

test('ctx.drop() を呼ぶと dropped イベントが発生する', async () => {
  const detector = new ManualDropDetector();
  const drops = new AwaitableQueue<void>();
  const unipls = new Unipls({ url, dropDetectors: [detector] });

  unipls.on('dropped', () => drops.enqueue());

  await unipls.open();
  await mock.sockets.dequeue();

  const ctx = await detector.setups.dequeue();
  ctx.drop();

  await expect(drops.dequeue()).resolves.toBeUndefined();

  await unipls.close();
});

test('切断時に dispose が呼ばれる', async () => {
  const detector = new ManualDropDetector();
  const unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  const server = await mock.sockets.dequeue();

  await detector.setups.dequeue();

  server.close(3001);

  await expect(detector.disposes.dequeue()).resolves.toBeUndefined();

  await unipls.close();
});

test('close() 時に dispose が呼ばれる', async () => {
  const detector = new ManualDropDetector();
  const unipls = new Unipls({ url, dropDetectors: [detector] });

  await unipls.open();
  await mock.sockets.dequeue();

  await detector.setups.dequeue();

  await unipls.close();

  await expect(detector.disposes.dequeue()).resolves.toBeUndefined();
});

test('再接続後に setup() が再度呼ばれる', async () => {
  const detector = new ManualDropDetector();
  const unipls = new Unipls({
    url,
    reconnector: alwaysReconnect,
    dropDetectors: [detector],
  });

  await unipls.open();
  const server = await mock.sockets.dequeue();

  await detector.setups.dequeue(); // 1 回目の setup

  server.close(3001);

  await mock.sockets.dequeue(); // 再接続後のソケット

  await expect(detector.setups.dequeue()).resolves.toBeDefined(); // 2 回目の setup

  await unipls.close();
});
