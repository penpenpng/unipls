import type { Unipls } from "../../src/index.ts";
import type { ControlledWebSocket, ControlledWebSocketServer } from "./controlled-websocket.ts";

/** test clientをopenし、接続済みの制御対象WebSocketを返します。 */
export async function openClient<TInput, TOutput>(
  client: Unipls<TInput, TOutput>,
  transport: ControlledWebSocketServer,
): Promise<ControlledWebSocket> {
  const opening = client.open();
  transport.current.emitOpen();
  await opening;
  return transport.current;
}

/** test clientのclose handshakeと非同期cleanupが完了するまで待機します。 */
export async function closeClient<TInput, TOutput>(
  client: Unipls<TInput, TOutput>,
  socket: { emitClose(): void },
): Promise<void> {
  const closing = client.close();
  socket.emitClose();
  await closing;
}
