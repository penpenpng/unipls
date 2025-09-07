import { afterEach, beforeEach, expect, test } from 'vitest';
import { AwaitableQueue } from '../libs/awaitable-queue';
import type { WebSocketData } from '../types';
import { Unipls } from '../unipls';
import { createMockServer } from './mock-server';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

beforeEach(async () => {});

afterEach(async () => {
  mock.reset();
});

test('`deserializer` option works correctly.', async () => {
  const unipls = new Unipls<number, number>({
    url,
    deserializer: (data: WebSocketData) => Number(data),
  });
  await unipls.open();
  const socket = await mock.sockets.dequeue();

  const inbox = new AwaitableQueue<number>();
  unipls.listen({
    onMessage: (message) => {
      inbox.enqueue(message);
    },
  });

  socket.send('1');
  socket.send('2');
  socket.send('3');

  await expect(inbox.dequeue()).resolves.toBe(1);
  await expect(inbox.dequeue()).resolves.toBe(2);
  await expect(inbox.dequeue()).resolves.toBe(3);
});
