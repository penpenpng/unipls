import { expect, test } from 'vitest';
import { createMockServer } from './__test__/mock-server';
import { createSocketClient } from './client-example';
import { AwaitableQueue } from './libs/awaitable-queue';

test('WebSocket client receives server greeting', async () => {
  using mock = createMockServer('ws://localhost:8080');
  const client = createSocketClient('ws://localhost:8080');
  const socket = await mock.sockets.dequeue();
  await client.opened;

  const messages = new AwaitableQueue<string>();
  client.onMessage((msg) => messages.enqueue(msg));

  const MESSAGE = 'hello from server';
  socket.send(MESSAGE);
  await expect(messages.dequeue()).resolves.toBe(MESSAGE);

  client.close();
});

test('WebSocket client sends ping and receives pong', async () => {
  using mock = createMockServer('ws://localhost:8080');
  const client = createSocketClient('ws://localhost:8080');
  const socket = await mock.sockets.dequeue();
  await client.opened;

  const messages = new AwaitableQueue<string>();
  client.onMessage((msg) => messages.enqueue(msg));

  client.send('ping');
  await expect(socket.messages.dequeue()).resolves.toBe('ping');
  socket.send('pong');
  await expect(messages.dequeue()).resolves.toBe('pong');

  client.close();
});
