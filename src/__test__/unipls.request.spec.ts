import { afterEach, expect, test } from 'vitest';
import {
  ImmediateReconnector,
  Unipls,
  UniplsClosedError,
  UniplsDroppedError,
  UniplsTimeoutError,
  type WebSocketData,
} from '..';
import { createMockServer } from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);
const query = {
  query: 'ping',
  selector: (msg: WebSocketData) => typeof msg === 'string' && msg === 'pong',
};

afterEach(() => {
  server.reset();
});

test('request() は query を送信した後、selector に合致する次にメッセージを取得する', async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const promise = unipls.request(query);
  socket.send('ignored');
  socket.send('pong');

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');
  await expect(promise).resolves.toBe('pong');
});

test('timeout した場合、 UniplsTimeoutError で reject する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const promise = unipls.request({
    ...query,
    timeout: 50,
  });

  await expect(promise).rejects.toThrow(UniplsTimeoutError);
});

test('signal が abort されると reject する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const controller = new AbortController();
  const promise = unipls.request({
    ...query,
    signal: controller.signal,
  });

  controller.abort(new Error('cancelled'));

  await expect(promise).rejects.toThrow('cancelled');
});

test('close() 時に UniplsClosedError で reject する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const promise = unipls.request(query);

  unipls.close();

  await expect(promise).rejects.toThrow(UniplsClosedError);
});

test(
  'reconnector が与えられていない場合、drop 時に UniplsDroppedError で reject する',
);

test(
  'reconnector が与えられていたとしても stopOnDropped オプションが有効ならば、drop 時に UniplsDroppedError で reject する',
);

test('reconnector が与えられていて、リトライ戦略に keep-listening が指定されている場合、再接続後に query の再送は行われないが、レスポンスの待機は継続する', async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const promise = unipls.request({
    ...query,
    retry: 'keep-listening',
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send('pong');

  await expect(socket1.inbox.dequeue()).resolves.toBe('ping');
  await expect(socket2.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(promise).resolves.toBe('pong');
});

test('reconnector が与えられていて、リトライ戦略に re-request が指定されている場合、再接続後に query の再送が行われ、レスポンスの待機も継続する', async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const promise = unipls.request({
    ...query,
    retry: 're-request',
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send('pong');

  await expect(socket1.inbox.dequeue()).resolves.toBe('ping');
  await expect(socket2.inbox.dequeue()).resolves.toBe('ping');
  await expect(promise).resolves.toBe('pong');
});

test('reconnector が与えられていて、リトライ戦略に never が指定されている場合、drop 時に UniplsDroppedError で reject する', async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const promise = unipls.request({
    ...query,
    retry: 'never',
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send('pong');

  await expect(socket1.inbox.dequeue()).resolves.toBe('ping');
  await expect(socket2.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(promise).rejects.toThrow(UniplsDroppedError);
});

test('query が関数形式の場合、再送時にペイロードは再評価される', async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  let counter = 0;
  const promise = unipls.request({
    query: () => `ping-${++counter}`,
    selector: (msg) => msg === 'pong',
    retry: 're-request',
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send('pong');

  await expect(socket1.inbox.dequeue()).resolves.toBe('ping-1');
  await expect(socket2.inbox.dequeue()).resolves.toBe('ping-2');
  await expect(promise).resolves.toBe('pong');
});
