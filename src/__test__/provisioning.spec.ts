import { afterEach, beforeEach, expect, test } from 'vitest';
import { Unipls } from '../unipls';
import { createMockServer, type SocketMock } from './mock-server';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

let pendingDone = () => {};
let unipls: Unipls<string, string>;
let server: SocketMock;

beforeEach(async () => {
  unipls = new Unipls<string, string>({ url });
  unipls.open((ctx) => {
    // done はテスト内で明示的に呼ぶ
    pendingDone = ctx.done;
  });
  server = await mock.sockets.dequeue();
});

afterEach(async () => {
  mock.reset();
});

test('provisioning 完了前は request の再送処理が起動しない', async () => {
  const promise = unipls.request('ping', {
    selector: (msg) => msg === 'pong',
    retry: 're-request',
  });
  await expect(server.inbox.dequeue({ timeout: 50 })).rejects.toThrowError();
  pendingDone();
  await expect(server.inbox.dequeue()).resolves.toBe('ping');
  server.send('pong');
  await expect(promise).resolves.toBe('pong');
  server.close(3001);
  server = await mock.sockets.dequeue();
  await expect(server.inbox.dequeue({ timeout: 50 })).rejects.toThrowError();
  pendingDone();
  // FIXME:
  await expect(server.inbox.dequeue()).resolves.toBe('ping');
  // server.send('pong');
  // await expect(promise).resolves.toBe('pong');
});
