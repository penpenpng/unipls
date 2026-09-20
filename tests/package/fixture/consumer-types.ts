import {
  HeartbeatDropDetector,
  Unipls,
  type AsyncSubscription,
  type StreamFinalization,
  type UniplsParams,
  type UniplsProvisioner,
  type UniplsRecoverStrategy,
  type UniplsReconnector,
} from "unipls";
import { NetworkDropDetector } from "unipls/browser";
import { UniplsSocket, type UniplsSocketParams, type WebSocketConstructor } from "unipls/socket";

declare const WebSocket: WebSocketConstructor;
const params: UniplsParams<string, string> = { url: "wss://example.test", WebSocket };
const client = new Unipls(params);
const socketParams: UniplsSocketParams<string, string> = params;
const socket = new UniplsSocket(socketParams);
const detector = new HeartbeatDropDetector({
  interval: 1_000,
  ping: "ping",
  pong: (message: string) => message === "pong",
});
const browserDetector = new NetworkDropDetector();

declare const provisioner: UniplsProvisioner<string, string>;
declare const reconnector: UniplsReconnector;
declare const recovery: UniplsRecoverStrategy<string, string>;

function observe(messages: AsyncSubscription<string>): Promise<StreamFinalization<string>> {
  return messages.closed;
}

void client;
void socket;
void detector;
void browserDetector;
void provisioner;
void reconnector;
void recovery;
void observe;
