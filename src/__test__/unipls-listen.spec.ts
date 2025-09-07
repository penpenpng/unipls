import { expect, test } from 'vitest';
import { AwaitableQueue } from '../libs/awaitable-queue';
import { Unipls } from '../unipls';
import { createMockServer } from './mock-server';

test('.listen() receives messages', async () => {
  const url = 'ws://localhost:8080';
  using mock = createMockServer(url);
  const unipls = new Unipls<string, string>({ url });
  await unipls.open();
  const socket = await mock.sockets.dequeue();

  const inbox = new AwaitableQueue<string>();
  unipls.listen({
    onMessage: (message) => {
      inbox.enqueue(message);
    },
  });

  socket.send('msg1');
  socket.send('msg2');
  socket.send('msg3');

  await expect(inbox.dequeue()).resolves.toBe('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg2');
  await expect(inbox.dequeue()).resolves.toBe('msg3');

  unipls.close();
});
