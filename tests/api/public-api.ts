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
  BrowserLifecycleReconnector,
  ImmediateReconnector,
  type ExponentialBackoffReconnectorOptions,
  type ImmediateReconnectorOptions,
  type UniplsReconnector,
} from "unipls/reconnectors";
import {
  BrowserLifecycleDropDetector,
  BrowserLifecycleSource,
  DropReasons,
  HeartbeatDropDetector,
  type UniplsDropDetector,
} from "unipls/drop-detectors";
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

// DOM global の宣言がなくても専用 entry point の公開型を利用できます。
const source = new BrowserLifecycleSource();
const lifecycleDetector: UniplsDropDetector<string, string> = new BrowserLifecycleDropDetector({
  source,
  createProbe: () => ({ query: "ping", selector: (msg) => msg === "pong" }),
});
const lifecycleReconnector: UniplsReconnector = new BrowserLifecycleReconnector({
  source,
  defaultReconnector: reconnector,
});
const customDetector: UniplsDropDetector<string, string> = {
  setup(ctx) {
    ctx.drop({ reason: DropReasons.HEARTBEAT_RESPONSE_TIMEOUT, metadata: { attempt: 1 } });
  },
};
void lifecycleDetector;
void lifecycleReconnector;
void customDetector;

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
