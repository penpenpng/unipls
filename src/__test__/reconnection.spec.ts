import { afterEach, expect, test } from 'vitest';
import { Unipls } from '..';
import {
  createMockServer,
  TestReconnector,
  TestSubscriber,
} from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test('drop 後、Reconnector は適切な初期コンテキストとともに呼び出される', async () => {
  const reconnector = new TestReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  await server.sockets.dequeue();

  unipls.drop();

  const ctx = await reconnector.dequeueContext();

  expect(ctx.session).toBeDefined();
  expect(ctx.lastAttemptedAt).toBeUndefined();
  expect(ctx.error).toBeUndefined();
  expect(ctx.sessionAttempts).toEqual([]);
  expect(ctx.allAttempts).toEqual([]);
  expect(ctx.signal.aborted).toBe(false);
  expect(ctx.reconnect).toBeTypeOf('function');
  expect(ctx.cancel).toBeTypeOf('function');
});

test('再度 drop したとき、Reconnector は直前までの再接続試行履歴を含むコンテキストとともに呼び出される', async () => {
  const reconnector = new TestReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  unipls.drop();

  const ctx1 = await reconnector.dequeueContext();
  const session = ctx1.session;
  ctx1.reconnect();

  const socket2 = await server.sockets.dequeue();
  socket2.send('after-first-reconnect');

  // Ensure the old socket is no longer relevant and the new connection is established.
  expect(socket1).not.toBe(socket2);

  unipls.drop();

  const ctx2 = await reconnector.dequeueContext();

  expect(ctx2.session).toBe(session);
  expect(ctx2.lastAttemptedAt).toBeTypeOf('number');
  expect(ctx2.error).toBeUndefined();
  expect(ctx2.sessionAttempts).toHaveLength(1);
  expect(ctx2.allAttempts).toHaveLength(1);
  expect(ctx2.sessionAttempts[0]?.session).toBe(session);
  expect(ctx2.allAttempts[0]?.session).toBe(session);
  expect(ctx2.signal.aborted).toBe(false);
});

test('drop 後、Reconnector が指定されていない場合は、再接続は実行されない', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.listen(sub);

  socket1.send('before-drop');

  await expect(sub.messages.dequeue()).resolves.toBe('before-drop');

  unipls.drop();

  await expect(server.sockets.dequeue({ timeout: 50 })).rejects.toThrow();
});

test('drop 後、Reconnector が reconnect() を呼び出したとき、再接続を実行する', async () => {
  const reconnector = new TestReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.listen(sub);

  socket1.send('before-drop');

  await expect(sub.messages.dequeue()).resolves.toBe('before-drop');

  unipls.drop();

  // Reconnection is deferred because reconnector is not settled yet.
  await expect(server.sockets.dequeue({ timeout: 50 })).rejects.toThrow();

  // Approve reconnection
  (await reconnector.dequeueContext()).reconnect();
  const socket2 = await server.sockets.dequeue();

  socket2.send('after-reconnect');

  await expect(sub.messages.dequeue()).resolves.toBe('after-reconnect');
});

test.skip('drop 後、Reconnector が cancel() を呼び出したとき、再接続は実行されない', () => {
  // TODO
});

test.skip('再接続成功時、reconnect イベントが発火する', async () => {
  // TODO
});

test.skip('drop 後、Reconnector が reconnect(), cancel() を呼び出す前に Unipls が close() されたとき、cleanup 関数が呼び出される', async () => {
  // TODO
});

test.skip('cleanup 関数が呼び出された後 reconnect(), cancel() を呼び出しても何も起こらない', async () => {
  // TODO
});
