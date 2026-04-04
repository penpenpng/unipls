import { afterEach, beforeEach, expect, test } from 'vitest';
import { Unipls } from '../unipls';
import { createMockServer, type SocketMock } from './test-utils';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

let pendingDone = () => {};
let unipls: Unipls<string, string>;
let socket: SocketMock;

beforeEach(async () => {
  unipls = new Unipls<string, string>({ url });
  unipls.open((ctx) => {
    // done はテスト内で明示的に呼ぶ
    pendingDone = ctx.done;
  });
  socket = await mock.sockets.dequeue();
});

afterEach(async () => {
  mock.reset();
});

test.skip('provisioning 完了前は request の送信・再送が起動しない', async () => {
  const promise = unipls.request({
    query: 'ping',
    selector: (msg) => msg === 'pong',
    retry: 're-request',
  });

  // provisioning 完了前は送信されない
  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrowError();

  // provisioning を完了させて初めて送信される
  pendingDone();
  await expect(socket.inbox.dequeue({ timeout: 200 })).resolves.toBe('ping');

  socket.send('pong');
  await expect(promise).resolves.toBe('pong');

  // 再接続前に pendingDone を次のセッション用に差し替え
  pendingDone = () => {};
  unipls.on('reconnect', (ev) => {
    void ev;
  });

  // drop して再接続
  socket.close(3001);
  socket = await mock.sockets.dequeue();

  // 再接続後も provisioning 完了前は送信されない
  await expect(socket.inbox.dequeue({ timeout: 50 })).rejects.toThrowError();

  // 再接続後の provisioning を完了させる
  pendingDone();

  await expect(socket.inbox.dequeue({ timeout: 200 })).resolves.toBe('ping');
});
