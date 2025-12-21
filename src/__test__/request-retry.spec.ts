import { afterEach, beforeEach, expect, test } from 'vitest';
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

test('request を再接続時に再送し、ペイロードを再評価する', async () => {
  let counter = 0;
  let expectedResponse = '';
  const payloadFactory = () => {
    const id = ++counter;
    expectedResponse = `pong-${id}`;
    return `ping-${id}`;
  };

  const promise = unipls.request(payloadFactory, {
    selector: (msg) => msg === expectedResponse,
    retry: 're-request',
  });

  // 1 回目の送信を確認するがレスポンスは返さない
  await expect(server.inbox.dequeue()).resolves.toBe('ping-1');

  // ドロップさせて再接続させる
  server.close(3001);

  const reconnected = await mock.sockets.dequeue();

  // 再接続後にペイロードが再評価され、2 回目が送信される
  await expect(reconnected.inbox.dequeue()).resolves.toBe('ping-2');

  reconnected.send('pong-2');

  await expect(promise).resolves.toBe('pong-2');
});
