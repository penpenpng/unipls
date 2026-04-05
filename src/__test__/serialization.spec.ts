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

test.skip('serializer が指定されたとき、送信するメッセージはシリアライズされる', async () => {
  // TODO
});

test.skip('デシリアライズに失敗したとき、next() は reject される', async () => {
  // TODO
});

test.skip('デシリアライズに失敗したとき、listen() は onError をトリガーする', async () => {
  // TODO
});

test.skip('デシリアライズに失敗したとき、request() は reject される', async () => {
  // TODO
});

test.skip('デシリアライズに失敗したとき、subscribe() は onError をトリガーする', async () => {
  // TODO
});

test.skip('シリアライズに失敗したとき、cast() は reject される', async () => {
  // TODO
});

test.skip('シリアライズに失敗したとき、request() は reject される', async () => {
  // TODO
});

test.skip('デシリアライズに失敗したとき、subscribe() は onFatalError をトリガーする', async () => {
  // TODO
});
