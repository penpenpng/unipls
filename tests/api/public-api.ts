import {
  Unipls,
  type AsyncSubscription,
  type ConnectionSetupContext,
  type StreamFinalization,
  type UniplsParams,
  type UniplsLog,
  type UniplsProvisioner,
  type UniplsRecoverStrategy,
} from "unipls";
import {
  ExponentialBackoffReconnector,
  ImmediateReconnector,
  type ExponentialBackoffReconnectorOptions,
  type ImmediateReconnectorOptions,
  type UniplsReconnector,
} from "unipls/reconnectors";
import { HeartbeatDropDetector, type UniplsDropDetector } from "unipls/drop-detectors";
import {
  UniplsSocket,
  UniplsSocketClosedError,
  type UniplsSocketParams,
  type WebSocketConstructor,
  type WebSocketLike,
} from "unipls/socket";

declare const WebSocket: WebSocketConstructor;

const params: UniplsParams<string, string> = {
  url: "wss://unipls.test/socket",
  WebSocket,
  serializer: (message) => message,
  deserializer: (data) => String(data),
  logSink: (log: UniplsLog) => {
    void log.level;
    void log.event;
    void log.message;
    void log.context;
    void log.cause;
  },
};
const client = new Unipls(params);
const socketParams: UniplsSocketParams<string, string> = params;
const lowLevelClient = new UniplsSocket(socketParams);

const provisioner: UniplsProvisioner<string, string> = {
  setupConnection(context: ConnectionSetupContext<string, string>) {
    context.defer(() => {});
  },
};
const immediateOptions: ImmediateReconnectorOptions = { maxRetries: 5 };
const reconnector: UniplsReconnector = new ImmediateReconnector(immediateOptions);
const backoffOptions: ExponentialBackoffReconnectorOptions = { maxRetries: 5 };
const backoffReconnector: UniplsReconnector = new ExponentialBackoffReconnector(backoffOptions);
const recover: UniplsRecoverStrategy<string, string> = {
  recover: () => "resend",
};
const detector: UniplsDropDetector<string, string> = new HeartbeatDropDetector({
  interval: 1_000,
  ping: "ping",
  pong: (message) => message === "pong",
});

function consumeStream(stream: AsyncSubscription<string>): Promise<StreamFinalization<string>> {
  return stream.closed;
}

function injectWebSocket(implementation: WebSocketLike): WebSocketLike {
  return implementation;
}

function classifySocketError(error: unknown): boolean {
  return error instanceof UniplsSocketClosedError;
}

void client;
void lowLevelClient;
void provisioner;
void reconnector;
void backoffReconnector;
void recover;
void detector;
void consumeStream;
void injectWebSocket;
void classifySocketError;
