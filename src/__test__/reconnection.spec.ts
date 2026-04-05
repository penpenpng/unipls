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
