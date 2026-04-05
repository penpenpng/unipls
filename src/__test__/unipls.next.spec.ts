import { afterEach, expect, test } from 'vitest';
import { Unipls, UniplsClosedError, UniplsTimeoutError } from '..';
import { createMockServer } from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test('next() は selector に合致する次のメッセージを取得する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();
  const socket = await server.sockets.dequeue();

  const promise = unipls.next({ selector: (msg) => msg === 'target' });

  socket.send('ignored');
  socket.send('target');

  await expect(promise).resolves.toBe('target');
});

test('timeout した場合、 UniplsTimeoutError で reject する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const promise = unipls.next({
    selector: () => true,
    timeout: 50,
  });

  await expect(promise).rejects.toThrow(UniplsTimeoutError);
});

test('signal が abort されると reject する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const controller = new AbortController();
  const promise = unipls.next({
    selector: () => true,
    signal: controller.signal,
  });

  controller.abort(new Error('cancelled'));

  await expect(promise).rejects.toThrow('cancelled');
});

test('close() 時に UniplsClosedError で reject する', async () => {
  await using unipls = new Unipls({ url });

  await unipls.open();

  const promise = unipls.next({ selector: () => true });

  unipls.close();

  await expect(promise).rejects.toThrow(UniplsClosedError);
});

test(
  'reconnector が与えられていない場合、drop 時に UniplsDroppedError で reject する',
);

// TODO: request などにあわせて、stopOnDropped の代わりに `retry: 'keep-listening' | 'never'` とする
test(
  'reconnector が与えられていたとしても stopOnDropped オプションが有効ならば、drop 時に UniplsDroppedError で reject する',
);

test(
  'reconnector が与えられている場合、next() は再接続後もメッセージを待機し続ける',
);
