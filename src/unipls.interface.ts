import type {
  AsyncSubscription,
  StreamCallbackDelivery,
  StreamFinalization,
  StreamIteratorDelivery,
  SubscriptionHandle,
} from "./async-results.ts";
import type { UniplsDropDetector } from "./drop-detector";
import type { UniplsReconnectEvent, UniplsReconnector } from "./reconnector/reconnector.ts";
import type { Disposer, MaybePromise, ResourceScope } from "./resource-scope.ts";
import type {
  ConnectionId,
  PredicateErrorPolicy,
  SessionId,
  WebSocketConstructor,
  WebSocketData,
} from "./types.ts";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- JSDoc のリンクで使用します。
import type { Unipls } from "./unipls.ts";

/** 送信するメッセージを値または評価関数として受け取ります。 */
export type UniplsMessageFactory<TInput = WebSocketData> = TInput | (() => TInput);

/** Unipls client の接続先、変換処理、回復方針を指定します。 */
export interface UniplsParams<TInput = WebSocketData, TOutput = WebSocketData> {
  /** 接続先の WebSocket URL です。 */
  url: string;
  /** 送信値を WebSocket が扱えるデータへ変換します。 */
  serializer?: (data: TInput) => WebSocketData;
  /** 受信した WebSocket データを利用者向けの値へ変換します。 */
  deserializer?: (data: WebSocketData) => TOutput;
  /** 接続に使う WebSocket 実装です。省略時は実行環境の `WebSocket` を使います。 */
  WebSocket?: WebSocketConstructor;
  /** WebSocket 接続の成立を待つ最大時間をミリ秒で指定します。 */
  timeout?: number;
  /** 再接続戦略を定義します。省略した場合は再接続を行いません。 */
  reconnector?: UniplsReconnector;
  /** ready な接続を監視する drop detector を登録順に指定します。 */
  dropDetectors?: UniplsDropDetector<TInput, TOutput>[];
}

/** 論理 session が終了するまで維持する resource を登録する context です。 */
export interface SessionSetupContext extends ResourceScope {
  /** resource を所有する論理 session です。 */
  readonly session: SessionId;
}

/** 接続が終了するまで維持する resource と ready 前の通信 capability を提供します。 */
export interface ConnectionSetupContext<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> extends ResourceScope {
  /**
   * {@link Unipls.cast|unipls.cast()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - signal は context の接続終了時に自動的に中断されます。
   * - 送信に失敗すると provisioner と現在の接続試行が失敗します。
   */
  cast(data: TInput): Promise<void>;

  /**
   * {@link Unipls.request|unipls.request()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsRequestParams.signal|signal} は指定できず、context の接続終了時に自動的に中断されます。
   * - {@link UniplsRequestParams.retry|retry} は指定できず、通信に失敗すると provisioner と現在の接続試行が失敗します。
   */
  request(params: Omit<UniplsRequestParams<TInput, TOutput>, "signal" | "retry">): Promise<TOutput>;

  /**
   * {@link Unipls.listen|unipls.listen()} とほとんど同様ですが、以下が異なります:
   * - {@link UniplsListenOptions.signal|signal} は指定できず、provisioning 完了時までに終了しなければ自動的に中断されます。
   * - {@link UniplsListenOptions.retry|retry} は指定できず、購読が失敗すると provisioner と現在の接続試行が失敗します。
   */
  listen(
    params: StreamCallbackDelivery<TOutput> &
      Omit<UniplsListenOptions<TOutput>, "signal" | "retry">,
  ): SubscriptionHandle<StreamFinalization<TOutput>>;
  listen(
    params: StreamIteratorDelivery & Omit<UniplsListenOptions<TOutput>, "signal" | "retry">,
  ): AsyncSubscription<TOutput>;

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsSubscribeParams.signal|signal} は指定できず、provisioning 完了時までに終了しなければ自動的に中断されます。
   * - {@link UniplsSubscribeParams.retry|retry} は指定できず、通信に失敗すると provisioner と現在の接続試行が失敗します。
   */
  subscribe(
    params: StreamCallbackDelivery<TOutput> &
      Omit<UniplsSubscribeParams<TInput, TOutput>, "signal" | "retry">,
  ): SubscriptionHandle<StreamFinalization<TOutput>>;
  subscribe(
    params: StreamIteratorDelivery &
      Omit<UniplsSubscribeParams<TInput, TOutput>, "signal" | "retry">,
  ): AsyncSubscription<TOutput>;

  /** resource を所有する論理 session です。 */
  readonly session: SessionId;
  /** capability が束縛された WebSocket 接続です。 */
  readonly connection: ConnectionId;
}

/** 論理 session と接続ごとの初期化処理を指定します。 */
export interface UniplsProvisioner<TInput = WebSocketData, TOutput = WebSocketData> {
  /** 論理 session ごとに一度だけ成功させる初期化処理です。 */
  setupSession?(context: SessionSetupContext): MaybePromise<void | Disposer>;
  /** 初回接続と回復接続を含む各 WebSocket 接続で実行する初期化処理です。 */
  setupConnection(context: ConnectionSetupContext<TInput, TOutput>): MaybePromise<void | Disposer>;
}

/** 次に selector と一致するメッセージを待つ方法を指定します。 */
export interface UniplsNextParams<TOutput = WebSocketData> {
  /** どのメッセージをレスポンスとみなすかを決定する述語関数です。この条件を最初に満たしたメッセージがレスポンスになります。 */
  selector: (data: TOutput) => boolean;

  /** レスポンスを待つ最大時間をミリ秒単位で指定します。省略した場合は無制限に待ちます。 */
  timeout?: number;

  /** メッセージ待機を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** レスポンス待機中に drop が発生した場合の待機継続戦略を指定します。 */
  retry?: UniplsDropRetryStrategy;

  /** selector が例外を投げた場合に操作を継続するか終了するかを指定します。 */
  predicateError?: PredicateErrorPolicy;
}

/** {@link Unipls.listen} の受信条件と終了条件を指定します。 */
export interface UniplsListenOptions<TOutput = WebSocketData> {
  /** どのメッセージを購読の対象とみなすかを決定する述語関数です。この条件を満たしたすべてのメッセージが購読の対象になります。 */
  selector?: (data: TOutput) => boolean;

  /** どのメッセージを購読の終端とみなすかを決定する述語関数です。この条件を最初に満たしたメッセージが購読の終端になります。 */
  terminator?: (data: TOutput) => boolean;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** 購読を続ける最大時間をミリ秒単位で指定します。省略した場合は無制限に待ちます。 */
  timeout?: number;

  /** 購読中に drop が発生した場合の待機継続戦略を指定します。 */
  retry?: UniplsDropRetryStrategy;

  /** selector または terminator が例外を投げた場合に購読を継続するか終了するかを指定します。 */
  predicateError?: PredicateErrorPolicy;
}

/** callback で {@link Unipls.listen} のメッセージを受け取る指定です。 */
export type UniplsListenCallbackParams<TOutput = WebSocketData> = UniplsListenOptions<TOutput> &
  StreamCallbackDelivery<TOutput>;

/** AsyncIterable で {@link Unipls.listen} のメッセージを受け取る指定です。 */
export type UniplsListenIteratorParams<TOutput = WebSocketData> = UniplsListenOptions<TOutput> &
  StreamIteratorDelivery;

/**
 * {@link Unipls.cast} で送信する値と待機条件を指定します。
 */
export interface UniplsCastParams<TInput = WebSocketData> {
  /** 送信する値、または実際の送信時に値を生成する関数です。 */
  query: UniplsMessageFactory<TInput>;
  /** 送信完了を待つ最大時間をミリ秒単位で指定します。省略した場合は無制限に待ちます。 */
  timeout?: number;
  /** 送信待機を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;
}

/** {@link Unipls.request} の送信値、応答条件、回復方法を指定します。 */
export interface UniplsRequestParams<TInput = WebSocketData, TOutput = WebSocketData> {
  /** 送信する値、または実際の送信時に値を生成する関数です。 */
  query: UniplsMessageFactory<TInput>;
  /** どのメッセージをレスポンスとみなすかを決定する述語関数です。この条件を最初に満たしたメッセージがレスポンスになります。 */
  selector: (data: TOutput) => boolean;

  /** レスポンスを待つ最大時間をミリ秒単位で指定します。省略した場合は無制限に待ちます。 */
  timeout?: number;

  /** レスポンスの待機またはリクエストの再送を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** レスポンスを待つまでの間に再接続が発生した場合のための再送戦略を指定します。 */
  retry?: UniplsRetryStrategy<TInput, TOutput>;

  /** selector が例外を投げた場合に操作を継続するか終了するかを指定します。 */
  predicateError?: PredicateErrorPolicy;
}

/**
 * {@link Unipls.request} または {@link Unipls.subscribe} が drop をまたぐ場合の回復方法を指定します。
 * - `fail`: リクエストを再送せず、例外終了します。
 * - `wait`: 再接続後にリクエストは再送しませんが、レスポンスを待機し続けます。
 * - `resend`: 再度同じリクエストを送信します。
 * - {@link UniplsRecoverStrategy}: 再接続後の回復方法を callback で決定します。
 */
export type UniplsRetryStrategy<TInput = WebSocketData, TOutput = WebSocketData> =
  | UniplsRetryPreset
  | UniplsRecoverStrategy<TInput, TOutput>;

/** 再接続後の request または subscribe の扱いを簡潔に指定します。 */
export type UniplsRetryPreset = "fail" | "wait" | "resend";

/**
 * {@link Unipls.next|unipls.next()} または {@link Unipls.listen|unipls.listen()} で利用可能な、drop 時の待機継続戦略です。
 */
export type UniplsDropRetryStrategy = "fail" | "wait";

/** custom recovery 関数へ渡される直前の query、selector、再接続情報です。 */
export interface UniplsRecoverContext<TInput = WebSocketData, TOutput = WebSocketData> {
  /** drop 前に使用していた query です。 */
  query: UniplsMessageFactory<TInput>;
  /** drop 前に使用していた selector です。 */
  selector: (data: TOutput) => boolean;
  /** 成功した再接続の情報です。 */
  reconnection: UniplsReconnectEvent;
}

/**
 * custom retry strategy が返す回復計画です。
 * `query` または `selector` を返した場合、その内容で再送します。
 */
export interface UniplsRecoveryPlan<TInput = WebSocketData, TOutput = WebSocketData> {
  query?: UniplsMessageFactory<TInput>;
  selector?: (data: TOutput) => boolean;
}

/** custom recovery が選択できる継続方法です。 */
export type UniplsRecoveryDecision<TInput = WebSocketData, TOutput = WebSocketData> =
  | Exclude<UniplsRetryPreset, "resend">
  | "resend"
  | UniplsRecoveryPlan<TInput, TOutput>
  | void;

/** 再接続後の query と selector を利用者が決定する回復戦略です。 */
export interface UniplsRecoverStrategy<TInput = WebSocketData, TOutput = WebSocketData> {
  /** 成功した再接続ごとに呼ばれ、今回の回復方法を返します。 */
  recover: (
    ctx: UniplsRecoverContext<TInput, TOutput>,
  ) => UniplsRecoveryDecision<TInput, TOutput> | Promise<UniplsRecoveryDecision<TInput, TOutput>>;
}

/** {@link Unipls.subscribe} の送信値、受信条件、終了条件、回復方法を指定します。 */
export interface UniplsSubscribeParams<TInput = WebSocketData, TOutput = WebSocketData> {
  /** 送信する値、または実際の送信時に値を生成する関数です。 */
  query: UniplsMessageFactory<TInput>;

  /** どのメッセージを購読の対象とみなすかを決定する述語関数です。この条件を満たしたすべてのメッセージが購読の対象になります。 */
  selector: (data: TOutput) => boolean;

  /** どのメッセージを購読の終端とみなすかを決定する述語関数です。この条件を最初に満たしたメッセージが購読の終端になります。 */
  terminator?: (data: TOutput) => boolean;

  /** 購読の終端を待つ最大時間をミリ秒単位で指定します。省略した場合は無制限に待ちます。 */
  timeout?: number;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** 購読の終端を待つまでの間に再接続が発生した場合のための再送戦略を指定します。 */
  retry?: UniplsRetryStrategy<TInput, TOutput>;

  /** selector または terminator が例外を投げた場合に購読を継続するか終了するかを指定します。 */
  predicateError?: PredicateErrorPolicy;
}

/** callback で {@link Unipls.subscribe} のメッセージを受け取る指定です。 */
export type UniplsSubscribeCallbackParams<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> = UniplsSubscribeParams<TInput, TOutput> & StreamCallbackDelivery<TOutput>;

/** AsyncIterable で {@link Unipls.subscribe} のメッセージを受け取る指定です。 */
export type UniplsSubscribeIteratorParams<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> = UniplsSubscribeParams<TInput, TOutput> & StreamIteratorDelivery;
