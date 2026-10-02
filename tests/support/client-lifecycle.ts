import { Unipls, type UniplsLog } from "../../src/index.ts";
import { ControlledWebSocketServer, type ControlledWebSocket } from "./controlled-websocket.ts";

export interface ReadyClientScenario {
  readonly client: Unipls<string, string>;
  readonly transport: ControlledWebSocketServer;
  readonly socket: ControlledWebSocket;
  readonly logs: UniplsLog[];
  close(): Promise<void>;
}

/** 標準設定のreadyなclientと、明示的なcleanupをまとめて返します。 */
export async function createReadyClient(): Promise<ReadyClientScenario> {
  const transport = new ControlledWebSocketServer();
  const logs: UniplsLog[] = [];
  const client = new Unipls<string, string>({
    url: "wss://unipls.test/socket",
    WebSocket: transport.WebSocket,
    logSink: (log) => logs.push(log),
  });
  const socket = await openClient(client, transport);
  return {
    client,
    transport,
    socket,
    logs,
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
