import { afterEach, beforeEach, expect, test } from 'vitest';
import { UniplsClosedError } from '../errors';
import { AwaitableQueue } from '../libs/awaitable-queue';
import { Unipls } from '../unipls';
import { createMockServer, type SocketMock } from './test-utils';

const url = 'ws://localhost:8080';
let unipls: Unipls<string, string>;
const mock = createMockServer(url);
let server: SocketMock;

beforeEach(async () => {
  unipls = new Unipls<string, string>({ url });
  await unipls.open();
  server = await mock.sockets.dequeue();
});

afterEach(async () => {
  unipls.close();
  mock.reset();
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

test('`terminator` option terminates subscription, and triggers `onTerminated` and `finally`.', async () => {
  const inbox = new AwaitableQueue<unknown>();
  unipls.listen({
    terminator: (message) => message === 'stop',
    onMessage: (message) => {
      inbox.enqueue(message);
    },
    onTerminated: (message) => {
      inbox.enqueue(message);
    },
    finally: () => {
      inbox.enqueue('finally');
    },
  });

  server.send('msg1');
  server.send('msg2');
  server.send('stop');
  server.send('ignored');

  await expect(inbox.dequeue()).resolves.toBe('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg2');
  await expect(inbox.dequeue()).resolves.toBe('stop');
  await expect(inbox.dequeue()).resolves.toBe('finally');
  await expect(inbox.dequeue({ timeout: 50 })).rejects.toThrowError();
});

test('unsubscription trigger `onUnsubscribed` and `finally`.', async () => {
  const inbox = new AwaitableQueue<unknown>();
  const unsubscribe = unipls.listen({
    onMessage: (message) => {
      inbox.enqueue(message);
    },
    onUnsubscribed: () => {
      inbox.enqueue('unsubscribed');
    },
    finally: () => {
      inbox.enqueue('finally');
    },
  });

  server.send('msg1');
  server.send('msg2');
  await expect(inbox.dequeue()).resolves.toBe('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg2');

  unsubscribe();
  await expect(inbox.dequeue()).resolves.toBe('unsubscribed');
  await expect(inbox.dequeue()).resolves.toBe('finally');

  server.send('ignored');
  await expect(inbox.dequeue({ timeout: 50 })).rejects.toThrowError();
});

test('`close()` triggers `onFatalError` with `UniplsClosedError` and `finally`.', async () => {
  const inbox = new AwaitableQueue<unknown>();
  unipls.listen({
    onMessage: (message) => {
      inbox.enqueue(message);
    },
    onFatalError: (error) => {
      inbox.enqueue(error);
    },
    finally: () => {
      inbox.enqueue('finally');
    },
  });

  server.send('msg1');
  server.send('msg2');
  await expect(inbox.dequeue()).resolves.toBe('msg1');
  await expect(inbox.dequeue()).resolves.toBe('msg2');

  unipls.close();
  await expect(inbox.dequeue()).resolves.toBeInstanceOf(UniplsClosedError);
  await expect(inbox.dequeue()).resolves.toBe('finally');

  server.send('ignored');
  await expect(inbox.dequeue({ timeout: 50 })).rejects.toThrowError();
});
