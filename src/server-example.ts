// handlers.ts
import { ws } from 'msw';

const link = ws.link('ws://localhost:8080');

export const handlers = [
  link.addEventListener('connection', ({ client }) => {
    client.send('hello from server');
    client.addEventListener('message', (ev) => {
      if (ev.data === 'ping') {
        client.send('pong');
      }
    });
  }),
];
