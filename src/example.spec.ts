// socketClient.test.ts
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createSocketClient } from './client-example';
import { handlers } from './server-example';

const server = setupServer(...handlers);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

test('WebSocket client receives server greeting', async () => {
  const client = createSocketClient('ws://localhost:8080');

  const messages: string[] = [];
  client.onMessage((msg) => messages.push(msg));

  await new Promise((r) => setTimeout(r, 50));

  expect(messages).toContain('hello from server');
});

test('WebSocket client sends ping and receives pong', async () => {
  const client = createSocketClient('ws://localhost:8080');

  const messages: string[] = [];
  client.onMessage((msg) => messages.push(msg));

  await new Promise((r) => setTimeout(r, 50));
  client.send('ping');

  await new Promise((r) => setTimeout(r, 50));

  expect(messages).toContain('pong');
});
