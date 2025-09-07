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
    selector: (message) => message.startsWith('msg'),
    onMessage: (message) => {
      inbox.enqueue(message);
    },
  });

  server.send('msg1');
  server.send('ignored');
  server.send('msg2');
  server.send('ignored');
  server.send('msg3');

  await expect(inbox.dequeue()).resolves.toBe('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg2');
  await expect(inbox.dequeue()).resolves.toBe('msg3');
});

test('`terminator` option terminates subscription.', async () => {
  const inbox = new AwaitableQueue<unknown>();
  unipls.listen({
    terminator: (message) => message === 'stop',
    onMessage: (message) => {
      inbox.enqueue(message);
    },
    onTerminated: (message) => {
      inbox.enqueue(message);
    },
  });

  server.send('msg1');
  server.send('msg2');
  server.send('stop');
  server.send('ignored');

  await expect(inbox.dequeue()).resolves.toBe('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg2');
  await expect(inbox.dequeue()).resolves.toBe('stop');
  await expect(inbox.dequeue({ timeout: 50 })).rejects.toThrowError();
});
