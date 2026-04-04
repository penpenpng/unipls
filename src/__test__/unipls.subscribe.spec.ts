import { afterEach, beforeEach, expect, test } from 'vitest';
import { Unipls, UniplsClosedError, UniplsDroppedError } from '..';
import {
  AwaitableQueue,
  createMockServer,
  immediateReconnector,
  type SocketMock,
} from './test-utils';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

let unipls: Unipls<string, string>;
let socket: SocketMock;

beforeEach(async () => {
  unipls = new Unipls<string, string>({
    url,
    reconnector: immediateReconnector,
  });
  await unipls.open();
  socket = await mock.sockets.dequeue();
});

afterEach(async () => {
  await unipls.close();
  mock.reset();
});

test('クエリを送信し、selector に合致した複数のメッセージを受信する', async () => {
  const inbox = new AwaitableQueue<string>();
  unipls.subscribe({
    query: 'subscribe-cmd',
    selector: (msg) => msg.startsWith('item-'),
    onMessage: (msg) => inbox.enqueue(msg),
  });

  await expect(socket.inbox.dequeue()).resolves.toBe('subscribe-cmd');

  socket.send('item-1');
  socket.send('ignored');
  socket.send('item-2');

  await expect(inbox.dequeue()).resolves.toBe('item-1');
  await expect(inbox.dequeue()).resolves.toBe('item-2');
});

test('terminator に合致したメッセージで購読が終了し、onTerminated が呼ばれる', async () => {
  const inbox = new AwaitableQueue<unknown>();
  unipls.subscribe({
    query: 'subscribe-cmd',
    selector: (msg) => msg.startsWith('item-'),
    terminator: (msg) => msg === 'done',
    onMessage: (msg) => inbox.enqueue(msg),
    onTerminated: (msg) => inbox.enqueue(`terminated:${msg}`),
    finally: () => inbox.enqueue('finally'),
  });

  await socket.inbox.dequeue();

  socket.send('item-1');
  socket.send('done');
  socket.send('ignored');

  await expect(inbox.dequeue()).resolves.toBe('item-1');
  await expect(inbox.dequeue()).resolves.toBe('terminated:done');
  await expect(inbox.dequeue()).resolves.toBe('finally');
  await expect(inbox.dequeue({ timeout: 50 })).rejects.toThrowError();
});

test('unsubscribe で購読が解除され onUnsubscribed が呼ばれる', async () => {
  const inbox = new AwaitableQueue<unknown>();
  const unsubscribe = unipls.subscribe({
    query: 'subscribe-cmd',
    selector: () => true,
    onMessage: (msg) => inbox.enqueue(msg),
    onUnsubscribed: () => inbox.enqueue('unsubscribed'),
    finally: () => inbox.enqueue('finally'),
  });

  await socket.inbox.dequeue();

  socket.send('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg1');

  unsubscribe();
  await expect(inbox.dequeue()).resolves.toBe('unsubscribed');
  await expect(inbox.dequeue()).resolves.toBe('finally');

  socket.send('ignored');
  await expect(inbox.dequeue({ timeout: 50 })).rejects.toThrowError();
});

test('close() 時に onFatalError が UniplsClosedError で呼ばれる', async () => {
  const inbox = new AwaitableQueue<unknown>();
  unipls.subscribe({
    query: 'subscribe-cmd',
    selector: () => true,
    onMessage: (msg) => inbox.enqueue(msg),
    onFatalError: (err) => inbox.enqueue(err),
    finally: () => inbox.enqueue('finally'),
  });

  await socket.inbox.dequeue();

  socket.send('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg1');

  unipls.close();
  await expect(inbox.dequeue()).resolves.toBeInstanceOf(UniplsClosedError);
  await expect(inbox.dequeue()).resolves.toBe('finally');
});

test('retry が未指定のとき、切断時に onFatalError が UniplsDroppedError で呼ばれる', async () => {
  const inbox = new AwaitableQueue<unknown>();
  unipls.subscribe({
    query: 'subscribe-cmd',
    selector: () => true,
    onMessage: (msg) => inbox.enqueue(msg),
    onFatalError: (err) => inbox.enqueue(err),
  });

  await socket.inbox.dequeue();

  socket.close(3001);
  await expect(inbox.dequeue()).resolves.toBeInstanceOf(UniplsDroppedError);
});

test('retry が re-request のとき、再接続後にクエリを再送してメッセージを受信する', async () => {
  let counter = 0;
  const inbox = new AwaitableQueue<string>();

  unipls.subscribe({
    query: () => `subscribe-cmd-${++counter}`,
    selector: (msg) => msg.startsWith('item-'),
    retry: 're-request',
    onMessage: (msg) => inbox.enqueue(msg),
  });

  await expect(socket.inbox.dequeue()).resolves.toBe('subscribe-cmd-1');

  socket.close(3001);

  const reconnected = await mock.sockets.dequeue();
  await expect(reconnected.inbox.dequeue()).resolves.toBe('subscribe-cmd-2');

  reconnected.send('item-after-reconnect');
  await expect(inbox.dequeue()).resolves.toBe('item-after-reconnect');
});

test('retry が keep-listening のとき、再接続後もクエリを再送せずメッセージを受信する', async () => {
  const inbox = new AwaitableQueue<string>();

  unipls.subscribe({
    query: 'subscribe-cmd',
    selector: (msg) => msg.startsWith('item-'),
    retry: 'keep-listening',
    onMessage: (msg) => inbox.enqueue(msg),
  });

  await expect(socket.inbox.dequeue()).resolves.toBe('subscribe-cmd');

  socket.close(3001);

  const reconnected = await mock.sockets.dequeue();

  // クエリは再送されない
  await expect(
    reconnected.inbox.dequeue({ timeout: 50 }),
  ).rejects.toThrowError();

  reconnected.send('item-after-reconnect');
  await expect(inbox.dequeue()).resolves.toBe('item-after-reconnect');
});
