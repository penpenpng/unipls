import { afterEach, beforeEach, expect, test } from 'vitest';
import { AwaitableQueue } from '../libs/awaitable-queue';
import { Unipls } from '../unipls';
import { createMockServer, type SocketMock } from './mock-server';

const url = 'ws://localhost:8080';
let unipls: Unipls<string, string>;
let mock: ReturnType<typeof createMockServer>;
let server: SocketMock;

beforeEach(async () => {
  mock = createMockServer(url);
  unipls = new Unipls<string, string>({ url });
  await unipls.open();
  server = await mock.sockets.dequeue();
});

afterEach(async () => {
  unipls.close();
  mock[Symbol.dispose]();
});

test('`.listen()` receives messages.', async () => {
  const inbox = new AwaitableQueue<string>();
  unipls.listen({
    onMessage: (message) => {
      inbox.enqueue(message);
    },
  });

  server.send('msg1');
  server.send('msg2');
  server.send('msg3');

  await expect(inbox.dequeue()).resolves.toBe('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg2');
  await expect(inbox.dequeue()).resolves.toBe('msg3');
});

test('`selector` option filters messages.', async () => {
  const inbox = new AwaitableQueue<string>();
  unipls.listen({
    selector: (message) => message.startsWith('foo'),
    onMessage: (message) => {
      inbox.enqueue(message);
    },
  });

  server.send('foo1');
  server.send('bar1');
  server.send('foo2');
  server.send('bar2');
  server.send('foo3');

  await expect(inbox.dequeue()).resolves.toBe('foo1');
  await expect(inbox.dequeue()).resolves.toBe('foo2');
  await expect(inbox.dequeue()).resolves.toBe('foo3');
});
