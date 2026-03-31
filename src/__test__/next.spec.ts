import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  UniplsClosedError,
  UniplsDroppedError,
  UniplsTimeoutError,
} from '../errors';
import { Unipls } from '../unipls';
import type { UniplsReconnector } from '../unipls-reconnector';
import { createMockServer, type SocketMock } from './mock-server';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

const alwaysReconnect: UniplsReconnector = { reconnect: () => true };

let unipls: Unipls<string, string>;
let server: SocketMock;

beforeEach(async () => {
  unipls = new Unipls<string, string>({ url });
  await unipls.open();
  server = await mock.sockets.dequeue();
});

afterEach(async () => {
  await unipls.close();
  mock.reset();
});

test('selector に合致したメッセージで resolve する', async () => {
  const promise = unipls.next({ selector: (msg) => msg === 'target' });

  server.send('target');

  await expect(promise).resolves.toBe('target');
});

test('selector が一致しないメッセージを無視し、一致したときに resolve する', async () => {
  const promise = unipls.next({ selector: (msg) => msg.startsWith('ok-') });

  server.send('ng-1');
  server.send('ng-2');
  server.send('ok-1');

  await expect(promise).resolves.toBe('ok-1');
});

test('timeout 時に UniplsTimeoutError で reject する', async () => {
  const promise = unipls.next({
    selector: () => true,
    timeout: 50,
  });

  await expect(promise).rejects.toBeInstanceOf(UniplsTimeoutError);
});

test('signal が abort されると reject する', async () => {
  const controller = new AbortController();
  const promise = unipls.next({
    selector: () => true,
    signal: controller.signal,
  });

  controller.abort(new Error('cancelled'));

  await expect(promise).rejects.toThrow('cancelled');
});

test('close() 時に UniplsClosedError で reject する', async () => {
  const promise = unipls.next({ selector: () => true });

  unipls.close();

  await expect(promise).rejects.toBeInstanceOf(UniplsClosedError);
});

test('stopListeningOnDisconnected が true のとき、切断時に UniplsDroppedError で reject する', async () => {
  const promise = unipls.next({
    selector: () => true,
    stopListeningOnDisconnected: true,
  });

  server.close(3001);

  await expect(promise).rejects.toBeInstanceOf(UniplsDroppedError);
});

test('stopListeningOnDisconnected が false のとき、再接続後もメッセージを待ち続ける', async () => {
  unipls = new Unipls<string, string>({ url, reconnector: alwaysReconnect });
  await unipls.open();
  server = await mock.sockets.dequeue();

  const promise = unipls.next({ selector: () => true });

  server.close(3001);

  const reconnectedServer = await mock.sockets.dequeue();
  reconnectedServer.send('after-reconnect');

  await expect(promise).resolves.toBe('after-reconnect');
});
