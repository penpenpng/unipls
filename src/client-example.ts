export function createSocketClient(url: string) {
  const socket = new WebSocket(url);
  const { promise, resolve } = Promise.withResolvers<void>();

  socket.onopen = () => {
    resolve();
  };

  function send(message: string) {
    socket.send(message);
  }

  function onMessage(callback: (msg: string) => void) {
    socket.addEventListener('message', (event) => {
      callback(event.data);
    });
  }

  function close() {
    socket.close();
  }

  return { socket, send, onMessage, close, opened: promise };
}
