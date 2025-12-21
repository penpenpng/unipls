import { afterEach, beforeEach, expect, test } from 'vitest';
import { AwaitableQueue } from '../libs/awaitable-queue';
import { Unipls } from '../unipls';
import { createMockServer, type SocketMock } from './mock-server';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

let unipls: Unipls<string, string>;
let server: SocketMock;

beforeEach(async () => {
  unipls = new Unipls<string, string>({ url });
  await unipls.open();
  server = await mock.sockets.dequeue();
});

afterEach(async () => {
  unipls.close();
  mock.reset();
});

test('drop されると自動で再接続する', async () => {
  const inbox = new AwaitableQueue<string>();
  unipls.listen({
    onMessage: (message) => {
      inbox.enqueue(message);
    },
  });

  // 1 回目の接続でメッセージを受信する
  server.send('before-drop');
  await expect(inbox.dequeue()).resolves.toBe('before-drop');

  // 異常コードで切断して drop を発生させる
  server.close(3001);

  // 自動再接続後のソケットが生成されることを確認
  const reconnectedServer = await mock.sockets.dequeue();

  reconnectedServer.send('after-reconnect');
  await expect(inbox.dequeue()).resolves.toBe('after-reconnect');
});

test('再接続後にプロビジョニングが再実行される', async () => {
  await unipls.close();
  server.close();

  const provisioned = new AwaitableQueue<number>();
  let provisionCount = 0;

  unipls = new Unipls<string, string>({ url });
  await unipls.open(({ done }) => {
    provisionCount += 1;
    provisioned.enqueue(provisionCount);
    done();
  });

  server = await mock.sockets.dequeue();

  await expect(provisioned.dequeue()).resolves.toBe(1);

  server.close(3001);

  await mock.sockets.dequeue();

  await expect(provisioned.dequeue()).resolves.toBe(2);
});

test('再接続時に reconnect イベントが発火する', async () => {
  const reconnects = new AwaitableQueue<{
    previousSessionId: number;
    sessionId: number;
  }>();

  unipls.on('reconnect', (ev) => {
    void reconnects.enqueue(ev);
  });

  server.close(3001);

  await mock.sockets.dequeue();

  const reconnectEvent = await reconnects.dequeue();

  expect(reconnectEvent.sessionId).not.toBe(reconnectEvent.previousSessionId);
  expect(reconnectEvent.sessionId).toBeGreaterThan(0);
});
