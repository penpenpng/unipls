import {
  Unipls,
  type AsyncSubscription,
  type StreamFinalization,
  type UniplsParams,
  type UniplsProvisioner,
  type UniplsRecoverStrategy,
} from "unipls";
import { HeartbeatDropDetector, NetworkDropDetector } from "unipls/drop-detectors";
import {
  ImmediateReconnector,
  type ImmediateReconnectorOptions,
  type UniplsReconnector,
} from "unipls/reconnectors";
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
const immediateOptions: ImmediateReconnectorOptions = { maxRetries: 3 };
const reconnector: UniplsReconnector = new ImmediateReconnector(immediateOptions);
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
