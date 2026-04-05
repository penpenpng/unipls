import { afterEach, expect, test } from 'vitest';
import {
  ImmediateReconnector,
  Unipls,
  UniplsClosedError,
  UniplsDroppedError,
} from '..';
import { createMockServer, TestSubscriber } from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test('listen() はメッセージを監視する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.listen(sub);

  socket.send('msg-1');
  socket.send('msg-2');
  socket.send('msg-3');

  await expect(sub.messages.dequeue()).resolves.toBe('msg-1');
  await expect(sub.messages.dequeue()).resolves.toBe('msg-2');
  await expect(sub.messages.dequeue()).resolves.toBe('msg-3');
});

test('selector オプションはメッセージをフィルタリングする', async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.listen({ ...sub, selector: (msg) => msg.startsWith('msg-') });

  socket.send('msg-1');
  socket.send('msg-2');
  socket.send('msg-3');

  await expect(sub.messages.dequeue()).resolves.toBe('msg-1');
  await expect(sub.messages.dequeue()).resolves.toBe('msg-2');
  await expect(sub.messages.dequeue()).resolves.toBe('msg-3');
});

test('terminator オプションがメッセージの終端を定義する', async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.listen({ ...sub, terminator: (msg) => msg === 'stop' });

  socket.send('msg-1');
  socket.send('msg-2');
  socket.send('stop');
  socket.send('ignored');

  await expect(sub.messages.dequeue()).resolves.toBe('msg-1');
  await expect(sub.messages.dequeue()).resolves.toBe('msg-2');
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
  const unsubscribe = unipls.listen(sub);

  unsubscribe();
  socket.send('ignored');

  await expect(sub.unsubscription).resolves.toBeUndefined();
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'unsubscribed',
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test('Unipls を close() すると reason: closed で onFatalError がトリガーされる', async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.listen(sub);

  unipls.close();
  socket.send('ignored');

  await expect(sub.termination).rejects.toThrow(UniplsClosedError);
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'closed',
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test('reconnector が与えられていない場合、drop 時に reason: dropped で onFatalError がトリガーされる', async () => {
  await using unipls = new Unipls<string, string>({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.listen(sub);

  unipls.drop();
  socket.send('ignored');

  await expect(sub.termination).rejects.toThrow(UniplsDroppedError);
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'dropped',
  });
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();
});

test('reconnector が与えられている場合、listen() は再接続後もメッセージを監視し続ける', async () => {
  const reconnector = new ImmediateReconnector();
  await using unipls = new Unipls({ url, reconnector });

  await unipls.open();
  await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.listen(sub);

  unipls.drop();
  const socket2 = await server.sockets.dequeue();

  socket2.send('msg-1');
  socket2.send('msg-2');

  await expect(sub.messages.dequeue()).resolves.toBe('msg-1');
  await expect(sub.messages.dequeue()).resolves.toBe('msg-2');
});
