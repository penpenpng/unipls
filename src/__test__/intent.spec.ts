import { afterEach, test } from 'vitest';
import { createMockServer } from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test.skip('open インテント中の送信は、必要であればバッファリングされる', async () => {
  // TODO
});

test.skip('open インテント中にバッファされた送信は、close インテントに遷移したときに破棄される', async () => {
  // TODO
});

test.skip('close インテント中に送信することはできない', async () => {
  // TODO
});

test.skip('close インテント中に受信することはできない', async () => {
  // TODO
});
