import { afterEach, test } from 'vitest';
import { createMockServer } from './test-utils';

const url = 'ws://localhost:8080';
const server = createMockServer(url);

afterEach(() => {
  server.reset();
});

test.skip('', async () => {
  // TODO
});
