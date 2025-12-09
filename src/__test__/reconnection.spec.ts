import { afterEach, beforeEach, expect, test } from 'vitest';
import { AwaitableQueue } from '../libs/awaitable-queue';
import type { WebSocketData } from '../types';
import { Unipls } from '../unipls';

const url = 'ws://localhost:8080';

beforeEach(async () => {});

afterEach(async () => {});

test.only('接続失敗シナリオの再現テスト', async () => {
  const unipls = new Unipls<number, number>({
    url,
    deserializer: (data: WebSocketData) => Number(data),
  });
  await unipls.open();

  const inbox = new AwaitableQueue<number>();
  unipls.listen({
    onMessage: (message) => {
      inbox.enqueue(message);
    },
  });

  await expect(inbox.dequeue()).resolves.toBe(1);
  await expect(inbox.dequeue()).resolves.toBe(2);
  await expect(inbox.dequeue()).resolves.toBe(3);
});
