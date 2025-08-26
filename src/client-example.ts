// socketClient.ts
export function createSocketClient(url: string) {
  const socket = new WebSocket(url);

  function send(message: string) {
    socket.send(message);
  }

  function onMessage(callback: (msg: string) => void) {
    socket.addEventListener('message', (event) => {
      callback(event.data);
    });
  }

  return { socket, send, onMessage };
}
