import { ws, type WebSocketData } from 'msw';
import { setupServer } from 'msw/node';
import { AwaitableQueue } from '../libs/awaitable-queue';

interface SocketMock {
  send(data: WebSocketData): void;
  close(): void;
  messages: AwaitableQueue<WebSocketData>;
  closeEvent: AwaitableQueue<CloseEvent>;
}

export function createMockServer(url: string) {
  const sockets = new AwaitableQueue<SocketMock>();

  const handler = ws.link(url).addEventListener('connection', ({ client }) => {
    const socket: SocketMock = {
      send(data) {
        client.send(data);
      },
      close() {
        client.close();
      },
      messages: new AwaitableQueue<WebSocketData>(),
      closeEvent: new AwaitableQueue<CloseEvent>(),
    };

    sockets.enqueue(socket);

    client.addEventListener('message', (ev) => {
      socket.messages.enqueue(ev.data);
    });
    client.addEventListener('close', (ev) => {
      socket.closeEvent.enqueue(ev);
    });
  });

  const server = setupServer(handler);
  server.listen();

  return {
    sockets,
    [Symbol.dispose]() {
      server.resetHandlers();
    },
  };
}
