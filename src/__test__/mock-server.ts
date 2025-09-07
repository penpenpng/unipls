import { ws, type WebSocketData } from 'msw';
import { setupServer } from 'msw/node';
import { AwaitableQueue } from '../libs/awaitable-queue';

export interface SocketMock {
  send(data: WebSocketData): void;
  close(): void;
  inbox: AwaitableQueue<WebSocketData>;
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
      inbox: new AwaitableQueue<WebSocketData>(),
      closeEvent: new AwaitableQueue<CloseEvent>(),
    };

    sockets.enqueue(socket);

    client.addEventListener('message', (ev) => {
      socket.inbox.enqueue(ev.data);
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
