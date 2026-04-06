import { afterEach, expect, test } from 'vitest';
import { Unipls, type WebSocketData } from '..';
import { createMockServer, TestSubscriber } from './test-utils';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

afterEach(async () => {
  mock.reset();
});

test('deserializer が指定されたとき、受信したメッセージはデシリアライズされる', async () => {
  await using unipls = new Unipls<number, number>({
    url,
    deserializer: (data: WebSocketData) => Number(data),
  });

  await unipls.open();
  const socket = await mock.sockets.dequeue();

  const sub = new TestSubscriber<number>();
  unipls.listen(sub);

  socket.send('1');
  socket.send('2');
  socket.send('3');

  await expect(sub.messages.dequeue()).resolves.toBe(1);
  await expect(sub.messages.dequeue()).resolves.toBe(2);
  await expect(sub.messages.dequeue()).resolves.toBe(3);
});

test('serializer が指定されたとき、送信するメッセージはシリアライズされる', async () => {
  await using unipls = new Unipls<number, string>({
    url,
    serializer: (data) => String(data),
  });

  await unipls.open();
  const socket = await mock.sockets.dequeue();

  await unipls.cast({
    query: 123,
  });

  await expect(socket.inbox.dequeue()).resolves.toBe('123');
});

test('デシリアライズに失敗したとき、next() は reject される', async () => {
  await using unipls = new Unipls<string, number>({
    url,
    deserializer: () => {
      throw new Error('invalid payload');
    },
  });

  await unipls.open();
  const socket = await mock.sockets.dequeue();

  const promise = unipls.next({
    selector: () => true,
  });

  socket.send('broken');

  await expect(promise).rejects.toThrow('invalid payload');
});

test('デシリアライズに失敗したとき、listen() は onError をトリガーする', async () => {
  await using unipls = new Unipls<string, number>({
    url,
    deserializer: () => {
      throw new Error('invalid payload');
    },
  });

  await unipls.open();
  const socket = await mock.sockets.dequeue();

  const sub = new TestSubscriber<number>();
  unipls.listen(sub);

  socket.send('broken');

  await expect(sub.errors.dequeue()).resolves.toMatchObject({
    message: 'invalid payload',
  });
});

test('デシリアライズに失敗したとき、request() は reject される', async () => {
  await using unipls = new Unipls<string, number>({
    url,
    deserializer: () => {
      throw new Error('invalid payload');
    },
  });

  await unipls.open();
  const socket = await mock.sockets.dequeue();

  const promise = unipls.request({
    query: 'ping',
    selector: () => true,
  });

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');

  socket.send('broken');

  await expect(promise).rejects.toThrow('invalid payload');
});

test('デシリアライズに失敗したとき、subscribe() は onError をトリガーする', async () => {
  await using unipls = new Unipls<string, number>({
    url,
    deserializer: () => {
      throw new Error('invalid payload');
    },
  });

  await unipls.open();
  const socket = await mock.sockets.dequeue();

  const sub = new TestSubscriber<number>();
  unipls.subscribe({
    ...sub,
    query: 'ping',
    selector: () => true,
  });

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');

  socket.send('broken');

  await expect(sub.errors.dequeue()).resolves.toMatchObject({
    message: 'invalid payload',
  });
});

test('シリアライズに失敗したとき、cast() は reject される', async () => {
  await using unipls = new Unipls<number, string>({
    url,
    serializer: () => {
      throw new Error('invalid payload');
    },
  });

  await unipls.open();
  await mock.sockets.dequeue();

  await expect(
    unipls.cast({
      query: 1,
    }),
  ).rejects.toThrow('invalid payload');
});

test('シリアライズに失敗したとき、request() は reject される', async () => {
  await using unipls = new Unipls<number, string>({
    url,
    serializer: () => {
      throw new Error('invalid payload');
    },
  });

  await unipls.open();
  await mock.sockets.dequeue();

  await expect(
    unipls.request({
      query: 1,
      selector: () => true,
    }),
  ).rejects.toThrow('invalid payload');
});

test('シリアライズに失敗したとき、subscribe() は onFatalError をトリガーする', async () => {
  await using unipls = new Unipls<number, string>({
    url,
    serializer: () => {
      throw new Error('invalid payload');
    },
  });

  await unipls.open();
  await mock.sockets.dequeue();

  const sub = new TestSubscriber<string>();
  unipls.subscribe({
    ...sub,
    query: 1,
    selector: () => true,
  });

  await expect(sub.termination).rejects.toThrow('invalid payload');
  await expect(sub.finalization).resolves.toMatchObject({
    reason: 'fatal-error',
  });
});
