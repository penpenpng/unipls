import { afterEach, beforeEach, expect, test } from 'vitest';
import { Unipls, UniplsClosedError, UniplsDroppedError } from '..';
import {
  createMockServer,
  immediateReconnector,
  SocketMock,
} from './test-utils';

const url = 'ws://localhost:8080';
const mock = createMockServer(url);

let unipls: Unipls<string, string>;
let socket: SocketMock;

beforeEach(async () => {
  unipls = new Unipls<string, string>({
    url,
    reconnector: immediateReconnector,
  });
  await unipls.open();
  socket = await mock.sockets.dequeue();
});

afterEach(async () => {
  await unipls.close();
  mock.reset();
});

test('メッセージを送信して resolve する', async () => {
  const promise = unipls.cast('hello');

  await expect(socket.inbox.dequeue()).resolves.toBe('hello');
  await expect(promise).resolves.toBeUndefined();
});

test('signal が既に abort されているとき同期的に throw する', () => {
  const signal = AbortSignal.abort(new Error('cancelled'));

  expect(() => unipls.cast('hello', { signal })).toThrow('cancelled');
});

test('state が closed のとき同期的に throw する', async () => {
  await unipls.close();

  expect(() => unipls.cast('hello')).toThrow(UniplsClosedError);
});

// recast のテストでは「enqueue が pending 中に drop する」シナリオが必要なため、
// プロビジョニング中 (done() 未呼出) の状態を活用します。
// cast(force=false) は 'open' イベント待ちで enqueue が pending になります。

test('recast が never のとき、送信前に drop が発生すると UniplsDroppedError で reject する', async () => {
  let provisionDone = () => {};
  const u = new Unipls<string, string>({ url });
  void u
    .open(({ done }) => {
      provisionDone = done;
    })
    .catch(() => {});
  const s = await mock.sockets.dequeue();

  // プロビジョニング中に cast を呼ぶ。enqueue は 'open' イベント待ちで pending になる
  const promise = u.cast('hello', { recast: 'never' });

  // pending 中に drop → enqueue 失敗 → 'never' recast → abort() → UniplsDroppedError
  s.close(3001);

  await expect(promise).rejects.toBeInstanceOf(UniplsDroppedError);

  void provisionDone; // suppress unused-variable lint
  await u.close();
});

test('recast が always（デフォルト）のとき、drop 後に再接続されてメッセージが再送される', async () => {
  let provisionDone = () => {};
  const u = new Unipls<string, string>({
    url,
    reconnector: immediateReconnector,
  });
  void u
    .open(({ done }) => {
      provisionDone = done;
    })
    .catch(() => {});
  const s = await mock.sockets.dequeue();

  // プロビジョニング中に cast を呼ぶ
  const promise = u.cast('hello');

  // pending 中に drop → 'always' recast: cast(data) + done() → promise resolve
  s.close(3001);
  await expect(promise).resolves.toBeUndefined();

  // 再接続後にプロビジョニングが完了すると 'open' イベントが発火し、メッセージが再送される
  const reconnectedServer = await mock.sockets.dequeue();
  provisionDone(); // 再接続後のプロビジョニングを完了させる
  await expect(reconnectedServer.inbox.dequeue()).resolves.toBe('hello');

  await u.close();
});

test('カスタム recast 関数で異なるデータを再送できる', async () => {
  let provisionDone = () => {};
  const u = new Unipls<string, string>({
    url,
    reconnector: immediateReconnector,
  });
  void u
    .open(({ done }) => {
      provisionDone = done;
    })
    .catch(() => {});
  const s = await mock.sockets.dequeue();

  const promise = u.cast('original', {
    recast: ({ cast, done }) => {
      cast('replaced');
      done();
    },
  });

  s.close(3001);
  await expect(promise).resolves.toBeUndefined();

  const reconnectedServer = await mock.sockets.dequeue();
  provisionDone();
  await expect(reconnectedServer.inbox.dequeue()).resolves.toBe('replaced');

  await u.close();
});
