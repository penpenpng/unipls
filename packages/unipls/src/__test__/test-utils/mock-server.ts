import { ws, type WebSocketData } from 'msw';
import { setupServer } from 'msw/node';
import { AwaitableQueue } from './awaitable-queue';

export interface SocketMock {
  send(data: WebSocketData): void;
  close(code?: number): void;
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
      close(code = 1000) {
        client.close(code);
      },
      inbox: new AwaitableQueue<WebSocketData>(),
      closeEvent: new AwaitableQueue<CloseEvent>(),
    };

    sockets.enqueue(socket);

    const onMessage = (ev: MessageEvent<WebSocketData>) => {
      socket.inbox.enqueue(ev.data);
    };
    const onClose = (ev: CloseEvent) => {
      client.removeEventListener('message', onMessage);
      client.removeEventListener('close', onClose);
      socket.closeEvent.enqueue(ev);
    };

    client.addEventListener('message', onMessage);
    client.addEventListener('close', onClose);
  });

  const server = setupServer(handler);
  server.listen();

  return {
    sockets,
    reset() {
      server.resetHandlers();
      sockets.clear();
    },
  };
}
