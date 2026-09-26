import { Unipls } from "../../src/index.ts";
import { ControlledWebSocketServer, type ControlledWebSocket } from "./controlled-websocket.ts";

export interface ReadyClientScenario {
  readonly client: Unipls<string, string>;
  readonly transport: ControlledWebSocketServer;
  readonly socket: ControlledWebSocket;
  close(): Promise<void>;
}

/** 標準設定のreadyなclientと、明示的なcleanupをまとめて返します。 */
export async function createReadyClient(): Promise<ReadyClientScenario> {
  const transport = new ControlledWebSocketServer();
  const client = new Unipls<string, string>({
    url: "wss://unipls.test/socket",
    WebSocket: transport.WebSocket,
  });
  const socket = await openClient(client, transport);
  return {
    client,
    transport,
    socket,
    close: () => closeClient(client, socket),
  };
}

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
