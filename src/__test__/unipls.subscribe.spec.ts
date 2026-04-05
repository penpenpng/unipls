import { afterEach, expect, test } from 'vitest';
import {
  ImmediateReconnector,
  Unipls,
  UniplsClosedError,
  UniplsDroppedError,
  type WebSocketData,
} from '..';
import { createMockServer, TestSubscriber } from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);
const query = {
  query: 'ping',
  selector: (msg: WebSocketData) =>
    typeof msg === 'string' && msg.startsWith('pong-'),
};

afterEach(() => {
  server.reset();
});

test('subscribe() は query を送信した後、selector に合致するメッセージを監視する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
  });
  socket.send('pong-1');
  socket.send('ignored');
  socket.send('pong-2');

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');
  await expect(sub.messages.dequeue()).resolves.toBe('pong-1');
  await expect(sub.messages.dequeue()).resolves.toBe('pong-2');
});

test('terminator オプションがメッセージの終端を定義する', async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    terminator: (msg) => msg === 'stop',
  });

  socket.send('pong-1');
  socket.send('pong-2');
  socket.send('stop');
  socket.send('ignored');

  await expect(sub.messages.dequeue()).resolves.toBe('pong-1');
  await expect(sub.messages.dequeue()).resolves.toBe('pong-2');
  await expect(sub.termination).resolves.toBe('stop');
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'terminated',
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test('unsubscribe によって onUnsubscribed と finally がトリガーされる', async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  const unsubscribe = unipls.subscribe({
    ...sub,
    ...query,
  });

  socket.send('pong-1');
  socket.send('pong-2');

  await expect(sub.messages.dequeue()).resolves.toBe('pong-1');
  await expect(sub.messages.dequeue()).resolves.toBe('pong-2');

  unsubscribe();
  socket.send('pong-3');

  await expect(sub.unsubscription).resolves.toBeUndefined();
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'unsubscribed',
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test('Unipls を close() すると onFatalError がトリガーされる', async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
  });

  socket.send('pong-1');
  socket.send('pong-2');

  await expect(sub.messages.dequeue()).resolves.toBe('pong-1');
  await expect(sub.messages.dequeue()).resolves.toBe('pong-2');

  unipls.close();
  socket.send('pong-3');

  await expect(sub.termination).rejects.toThrow(UniplsClosedError);
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'closed',
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test('signal が abort されると reject する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const sub = new TestSubscriber();
  const controller = new AbortController();
  const promise = unipls.subscribe({
    ...sub,
    ...query,
    signal: controller.signal,
  });

  controller.abort(new Error('cancelled'));

  await expect(promise).rejects.toThrow('cancelled');
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'aborted',
  });
});

test('close() 時に UniplsClosedError で reject する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const sub = new TestSubscriber();
  const promise = unipls.request({
    ...sub,
    ...query,
  });

  unipls.close();

  await expect(promise).rejects.toThrow(UniplsClosedError);
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'closed',
  });
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

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    retry: 'keep-listening',
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send('pong');

  await expect(socket1.inbox.dequeue()).resolves.toBe('ping');
  await expect(socket2.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(sub.messages.dequeue()).resolves.toBe('pong');
});

test('reconnector が与えられていて、リトライ戦略に re-request が指定されている場合、再接続後に query の再送が行われ、レスポンスの待機も継続する', async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    retry: 're-request',
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send('pong');

  await expect(socket1.inbox.dequeue()).resolves.toBe('ping');
  await expect(socket2.inbox.dequeue()).resolves.toBe('ping');
  await expect(sub.messages.dequeue()).resolves.toBe('pong');
});

test('reconnector が与えられていて、リトライ戦略に never が指定されている場合、drop 時に UniplsDroppedError で reject する', async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  const socket1 = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    ...query,
    retry: 're-request',
  });

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send('pong');

  await expect(socket1.inbox.dequeue()).resolves.toBe('ping');
  await expect(socket2.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(sub.termination).rejects.toThrow(UniplsDroppedError);
});
