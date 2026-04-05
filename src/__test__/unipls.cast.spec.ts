import { afterEach, expect, test } from 'vitest';
import { Unipls } from '..';
import { createMockServer } from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);
const query = { query: 'ping' };

afterEach(() => {
  server.reset();
});

test('cast() は query を送信する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  unipls.cast(query);

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');
});
