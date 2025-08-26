export type WebSocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

export type UniplsInitializer = (
  context: UniplsInitializationContext,
) => void | Promise<void>;
export interface UniplsInitializationContext {
  reconnection?: ReconnectionContext;
  cast(data: WebSocketData): void;
  request(data: WebSocketData): Promise<WebSocketData>;
  listen(): void;
  subscribe(data: WebSocketData): () => void;
  done(): void;
}

export interface UniplsCastOptions {
  recast?: RecastStrategy;
  signal?: AbortSignal;
}
export type RecastStrategy = 'never' | 'always' | RecastFunction;
export type RecastFunction = (ctx: RecastContext) => void;
export interface RecastContext<TInput = WebSocketData> {
  attempt: number;
  data: TInput;
  cast(data?: TInput): void;
  done(): void;
  abort(error?: unknown): void;
}

export interface UniplsRequestParams<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> {
  selector: (data: TOutput) => boolean;
  timeout?: number;
  signal?: AbortSignal;
  retry?: RetryStrategy<TInput, TOutput>;
}

export type RetryStrategy<TInput = WebSocketData, TOutput = WebSocketData> =
  | 'never'
  | 're-request'
  | 'keep-listening'
  | RetryFunction<TInput, TOutput>;
export type RetryFunction<TInput = WebSocketData, TOutput = WebSocketData> = (
  ctx: RetryContext<TInput, TOutput>,
) => void;
export interface RetryContext<TInput = WebSocketData, TOutput = WebSocketData> {
  attempt: number;
  data: TOutput;
  request(
    data: TInput,
    params: Pick<UniplsRequestParams<TInput, TOutput>, 'selector'>,
  ): void;
  done(): void;
  abort(error?: unknown): void;
}

export interface UniplsListenParams<TOutput> {
  selector: (data: TOutput) => boolean;
  terminator?: (data: TOutput) => boolean;
  signal?: AbortSignal;
  retry?: 'never' | 'always';
}

export interface UniplsSubscribeParams<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> {
  selector: (data: TOutput) => boolean;
  terminator?: (data: TOutput) => boolean;
  signal?: AbortSignal;
  retry?: RetryStrategy<TInput, TOutput>;
}

export interface UniplsParams<TInput = WebSocketData, TOutput = WebSocketData> {
  url: string;
  serializer?: (data: TInput) => WebSocketData;
  deserializer?: (data: WebSocketData) => TOutput;
  reconnector?: UniplsReconnector;
  WebSocket?: WebSocket;
}

export interface UniplsSubscriber<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> {
  onMessage: (data: TOutput, operations: SubscriberOperator<TInput>) => void;
  onTerminated?: (data: TOutput, operator: SubscriberOperator<TInput>) => void;
  onError?: (error: unknown, operator: SubscriberOperator<TInput>) => void;
  onFatalError?: (error: unknown) => void;
  finally?: (context: CleanupContext<TInput>) => void;
}

export interface CleanupContext<TInput = WebSocketData> {
  reason: SubscriptionEndReason;
  error?: unknown;
  cast?: (data: TInput) => void;
}

export type SubscriptionEndReason =
  | 'closed'
  | 'aborted'
  | 'unsubscribed'
  | 'terminated'
  | 'fatal-error';

export interface SubscriberOperator<TInput = WebSocketData> {
  unsubscribe(): void;
  cast(data: TInput): void;
}

export class Unipls<TInput = WebSocketData, TOutput = WebSocketData> {
  #url: string;
  #serialize: (data: TInput) => WebSocketData;
  #deserialize: (data: WebSocketData) => TOutput;

  constructor({
    url,
    serializer,
    deserializer,
  }: UniplsParams<TInput, TOutput>) {
    this.#url = url;
    this.#serialize = serializer ?? ((data) => data as WebSocketData);
    this.#deserialize = deserializer ?? ((data) => data as TOutput);
  }

  connect(initializer?: UniplsInitializer): Promise<void> {}
  close(): void {}

  cast(data: TInput, options?: UniplsCastOptions): void {}
  castForce(data: TInput, options?: UniplsCastOptions): void {}

  request(data: TInput, params: UniplsRequestParams<TInput, TOutput>) {}
  requestForce(data: TInput, params: UniplsRequestParams<TInput, TOutput>) {}

  listen(
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsListenParams<TOutput>,
  ) {}
  listenForce(
    subscriber: UniplsSubscriber<TOutput>,
    params: UniplsListenParams<TOutput>,
  ) {}

  subscribe(
    data: TInput,
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ) {}
  subscribeForce(
    data: TInput,
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ) {}
}

interface ReconnectionContext {
  session: number;
  streak: number;
  lastAttemptedAt?: number;
  error?: unknown;
  sessionAttempts: ReconnectionAttempt[];
  allAttempts: ReconnectionAttempt[];
  reconnect(): void;
  abort(): void;
}

interface ReconnectionAttempt {
  session: number;
  streak: number;
  attemptedAt: number;
  error?: unknown;
}

export abstract class UniplsReconnector {
  constructor() {}

  abstract reconnect(context: ReconnectionContext): Promise<void>;
}
