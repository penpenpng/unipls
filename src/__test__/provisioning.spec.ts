import { afterEach, expect, test } from 'vitest';
import { Unipls } from '..';
import {
  createMockServer,
  TestProvisioner,
  TestSubscriber,
  timeout,
  TimeoutError,
} from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test('初回接続後、Provisioning が完了するまで cast() の送信は遅延される', async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();

  const promise = unipls.cast({
    query: 'ping',
  });

  // 'ping' is not sent because provisioner is not settled yet.
  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(timeout(promise, 50)).rejects.toThrow(TimeoutError);

  // Complete provisioning manually.
  (await provisioner.dequeueContext()).resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');
});

test('初回接続後、Provisioning が完了するまで request() の送信は遅延される', async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();

  const response = unipls.request({
    query: 'ping',
    selector: (msg) => msg === 'pong',
  });

  // 'ping' is not sent because provisioner is not settled yet.
  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(timeout(response, 50)).rejects.toThrow();

  // Complete provisioning manually.
  (await provisioner.dequeueContext()).resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');
});

test('初回接続後、Provisioning が完了するまで subscribe() の送信は遅延される', async () => {
  await using unipls = new Unipls({ url });
  const provisioner = new TestProvisioner();

  unipls.open(provisioner);
  const socket = await server.sockets.dequeue();

  const sub = new TestSubscriber();
  unipls.subscribe({
    ...sub,
    query: 'ping',
    selector: (msg) => msg === 'pong',
  });

  // 'ping' is not sent because provisioner is not settled yet.
  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrow();
  await expect(sub.messages.dequeue({ timeout: 50 })).rejects.toThrow();

  // Complete provisioning manually.
  (await provisioner.dequeueContext()).resolve();

  await expect(socket.inbox.dequeue()).resolves.toBe('ping');
});

test.skip('再接続後、Provisioning が完了するまで request() の送信は遅延される', () => {
  // TODO
});
