import { afterEach, beforeEach, expect, test } from 'vitest';
import { AwaitableQueue } from '../libs/awaitable-queue';
import { Unipls } from '../unipls';
import type { UniplsReconnector } from '../unipls-reconnector';
import { createMockServer, type SocketMock } from './test-utils';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

/** 常に即時再接続する reconnector */
const alwaysReconnect: UniplsReconnector = { reconnect: () => true };

let unipls: Unipls<string, string>;
let socket: SocketMock;

beforeEach(async () => {
  unipls = new Unipls<string, string>({ url, reconnector: alwaysReconnect });
  await unipls.open();
  socket = await mock.sockets.dequeue();
});

afterEach(async () => {
  await unipls.close();
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
  socket.send('before-drop');
  await expect(inbox.dequeue()).resolves.toBe('before-drop');

  // 異常コードで切断して drop を発生させる
  socket.close(3001);

  // 自動再接続後のソケットが生成されることを確認
  const reconnectedServer = await mock.sockets.dequeue();

  reconnectedServer.send('after-reconnect');
  await expect(inbox.dequeue()).resolves.toBe('after-reconnect');
});

test('再接続後にプロビジョニングが再実行される', async () => {
  const provisioned = new AwaitableQueue<number>();
  let provisionCount = 0;

  unipls = new Unipls<string, string>({ url, reconnector: alwaysReconnect });
  await unipls.open(({ done }) => {
    provisionCount += 1;
    provisioned.enqueue(provisionCount);
    done();
  });

  socket = await mock.sockets.dequeue();

  await expect(provisioned.dequeue()).resolves.toBe(1);

  socket.close(3001);

  await mock.sockets.dequeue();

  await expect(provisioned.dequeue()).resolves.toBe(2);
});

test('再接続時に reconnect イベントが発火する', async () => {
  const reconnects = new AwaitableQueue<{ session: number }>();

  unipls.on('reconnect', (ev) => {
    void reconnects.enqueue(ev);
  });

  socket.close(3001);

  await mock.sockets.dequeue();

  const reconnectEvent = await reconnects.dequeue();

  expect(reconnectEvent.session).toBeGreaterThan(0);
});

test('再接続が複数回失敗した後に成功した場合、 sessionAttempts が正しい値になる', async () => {
  const reconnects = new AwaitableQueue<{
    sessionAttempts: readonly unknown[];
  }>();

  unipls.on('reconnect', (ev) => {
    void reconnects.enqueue(ev);
  });

  // 1 回目の切断 → 再接続試行 #1 開始
  socket.close(3001);

  // 再接続試行 #1 の接続を受け取り、即座に切断 → onFailure、試行 #2 開始
  const failedServer = await mock.sockets.dequeue();
  failedServer.close(3001);

  // 再接続試行 #2 の接続を受け取る（成功）
  await mock.sockets.dequeue();

  const reconnectEvent = await reconnects.dequeue();

  // 2 回試行して成功したので sessionAttempts.length === 2
  expect(reconnectEvent.sessionAttempts).toHaveLength(2);
});

test('reconnector が指定されていない場合は再接続しない', async () => {
  const uniплsNoReconnect = new Unipls<string, string>({ url });
  await uniплsNoReconnect.open();
  const s = await mock.sockets.dequeue();

  s.close(3001);

  // 再接続が発生しないことを確認（新しいソケットが来ない）
  await expect(mock.sockets.dequeue({ timeout: 100 })).rejects.toThrowError();
});

test('close() 呼び出し時に reconnector.reconnect() の待機がキャンセルされる', async () => {
  const reconnectCalled = new AwaitableQueue<void>();

  const slowReconnector: UniplsReconnector = {
    reconnect: async (ctx) => {
      reconnectCalled.enqueue();
      // close() が呼ばれるまで待機し続ける
      await new Promise<void>((_, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
      });
      return true;
    },
  };

  unipls = new Unipls<string, string>({ url, reconnector: slowReconnector });
  await unipls.open();
  socket = await mock.sockets.dequeue();

  socket.close(3001);

  // reconnect() が呼ばれるのを待つ
  await reconnectCalled.dequeue();

  // close() で待機がキャンセルされ、再接続は行われない
  await unipls.close();
  await expect(mock.sockets.dequeue({ timeout: 100 })).rejects.toThrowError();
});
