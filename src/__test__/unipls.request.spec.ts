import { afterEach, beforeEach, expect, test } from 'vitest';
import { Unipls, type UniplsReconnector } from '..';
import { createMockServer, type SocketMock } from './test-utils';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

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

test('request はセレクタに合致したレスポンスで resolve する', async () => {
  const promise = unipls.request({
    query: 'ping',
    selector: (msg) => msg === 'pong',
  });

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');

  socket.send('pong');

  await expect(promise).resolves.toBe('pong');
});

test('selector が一致しないレスポンスを無視し、一致したときに resolve する', async () => {
  const promise = unipls.request({
    query: 'ping',
    selector: (msg) => msg.startsWith('pong-ok'),
  });

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');

  socket.send('pong-ng');
  socket.send('pong-ok-1');

  await expect(promise).resolves.toBe('pong-ok-1');
});

test('request を再接続時に再送し、ペイロードを再評価する', async () => {
  let counter = 0;
  let expectedResponse = '';
  const payloadFactory = () => {
    const id = ++counter;
    expectedResponse = `pong-${id}`;
    return `ping-${id}`;
  };

  const promise = unipls.request({
    query: payloadFactory,
    selector: (msg) => msg === expectedResponse,
    retry: 're-request',
  });

  // 1 回目の送信を確認するがレスポンスは返さない
  await expect(socket.inbox.dequeue()).resolves.toBe('ping-1');

  // ドロップさせて再接続させる
  socket.close(3001);

  const reconnected = await mock.sockets.dequeue();

  // 再接続後にペイロードが再評価され、2 回目が送信される
  await expect(reconnected.inbox.dequeue()).resolves.toBe('ping-2');

  reconnected.send('pong-2');

  await expect(promise).resolves.toBe('pong-2');
});
