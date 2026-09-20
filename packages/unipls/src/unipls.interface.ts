import { type UniplsSubscriber } from "./async-results.ts";
import type { UniplsDropDetector } from "./drop-detector";
import type { UniplsReconnectEvent, UniplsReconnector } from "./reconnector/reconnector.ts";
import type { SessionId, WebSocketConstructor, WebSocketData } from "./types.ts";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Used by JSDoc
import type { Unipls } from "./unipls.ts";

/** 送信するメッセージを値または評価関数として受け取ります。 */
export type UniplsMessageFactory<TInput = WebSocketData> = TInput | (() => TInput);

export interface UniplsParams<TInput = WebSocketData, TOutput = WebSocketData> {
  url: string;
  serializer?: (data: TInput) => WebSocketData;
  deserializer?: (data: WebSocketData) => TOutput;
  WebSocket?: WebSocketConstructor;
  timeout?: number;
  /** 再接続戦略を定義します。省略した場合は再接続を行いません。 */
  reconnector?: UniplsReconnector;
  /** 切断検知プラグインのリストを指定します。各プラグインはプロビジョニング完了後に起動し、切断を検知した際に drop を発生させます。 */
  dropDetectors?: UniplsDropDetector<TInput, TOutput>[];
}

/**
 * {@link Unipls.open|unipls.connect()} の任意の引数で、{@link UniplsReconnector} による再接続を含む WebSocket 接続の成功直後に実行されます。
 */
export type UniplsProvisioner<TInput = WebSocketData, TOutput = WebSocketData> =
  | UniplsProvisionerFunction<TInput, TOutput>
  | UniplsProvisionerObject<TInput, TOutput>;

export type UniplsProvisionerFunction<TInput = WebSocketData, TOutput = WebSocketData> = (
  ctx: UniplsProvisioningContext<TInput, TOutput>,
) => Promise<void> | void;

export interface UniplsProvisionerObject<TInput = WebSocketData, TOutput = WebSocketData> {
  /** 論理 session ごとに一度だけ、成功するまで実行されます。 */
  setupSession?: UniplsProvisionerFunction<TInput, TOutput>;
  /** 各 transport epoch の connection setup として実行されます。 */
  setupConnection: UniplsProvisionerFunction<TInput, TOutput>;
}

/**
 * {@link UniplsProvisioner} の引数で、{@link Unipls} の初期化を行うためのコンテキストを表します。
 */
export interface UniplsProvisioningContext<TInput = WebSocketData, TOutput = WebSocketData> {
  /**
   * {@link Unipls.cast|unipls.cast()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsCastParams.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsCastParams.recast|recast} を指定することはできません。送信に失敗したときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  cast(data: TInput): Promise<void>;

  /**
   * {@link Unipls.request|unipls.request()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsRequestParams.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsRequestParams.retry|retry} を指定することはできません。送信に失敗したときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  request(params: Omit<UniplsRequestParams<TInput, TOutput>, "signal" | "retry">): Promise<TOutput>;

  /**
   * {@link Unipls.listen|unipls.listen()} とほとんど同様ですが、以下が異なります:
   * - {@link UniplsListenOptions.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsListenOptions.retry|retry} を指定することはできません。購読が中断されたときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  listen(
    params: UniplsSubscriber<TOutput> & Omit<UniplsListenOptions<TOutput>, "signal" | "retry">,
  ): void;

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsSubscribeParams.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsSubscribeParams.retry|retry} を指定することはできません。送信に失敗したときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  subscribe(
    params: UniplsSubscriber<TOutput> &
      Omit<UniplsSubscribeParams<TInput, TOutput>, "signal" | "retry">,
  ): () => void;

  /** 現在のセッションを表します。 */
  session: SessionId;

  /** これが現在のセッションの中での最初の初期化ならば `true`、そうでなければ `false` を与えます。 */
  isSessionBeginning: boolean;
}

export interface UniplsNextParams<TOutput = WebSocketData> {
  /** どのメッセージをレスポンスとみなすかを決定する述語関数です。この条件を最初に満たしたメッセージがレスポンスになります。 */
  selector: (data: TOutput) => boolean;

  /** レスポンスを待つ最大時間をミリ秒単位で指定します。省略した場合は無制限に待ちます。 */
  timeout?: number;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** レスポンス待機中に drop が発生した場合の待機継続戦略を指定します。 */
  retry?: UniplsDropRetryStrategy;
}

/** {@link Unipls.listen|unipls.listen()} の必須の第2引数で、`listen()` の挙動を制御します。 */
export interface UniplsListenOptions<TOutput = WebSocketData> {
  /** どのメッセージを購読の対象とみなすかを決定する述語関数です。この条件を満たしたすべてのメッセージが購読の対象になります。 */
  selector?: (data: TOutput) => boolean;

  /** どのメッセージを購読の終端とみなすかを決定する述語関数です。この条件を最初に満たしたメッセージが購読の終端になります。 */
  terminator?: (data: TOutput) => boolean;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** 購読中に drop が発生した場合の待機継続戦略を指定します。 */
  retry?: UniplsDropRetryStrategy;
}

/**
 * {@link Unipls.cast|unipls.cast()} の任意の第2引数で、`cast()` の挙動を制御します。
 */
export interface UniplsCastParams<TInput = WebSocketData> {
  query: UniplsMessageFactory<TInput>;
  /** Provisioning 終了を待つ最大時間をミリ秒単位で指定します。省略した場合は無制限に待ちます。 */
  timeout?: number;
  /**
   * 再送を中断するための {@link AbortSignal} を指定します。
   */
  signal?: AbortSignal;
}

/**
 * {@link UniplsRecastFunction} の引数で、再送の方法を制御するためのコンテキストを表します。
 */
export interface UniplsRecastContext<TInput = WebSocketData> {
  /** 直前に送信が試行されたデータを表します。すなわち、初回の再送では {@link Unipls.cast|unipls.cast()} の引数に等しく、それ以降の再送では直前の再送で送信を試行したデータに等しいです。 */
  data: TInput;

  /** 再送を試行します。 */
  cast(data: TInput): void;
}

/** {@link Unipls.request|unipls.request()} の必須の第2引数で、`request()` の挙動を制御します。 */
export interface UniplsRequestParams<TInput = WebSocketData, TOutput = WebSocketData> {
  query: UniplsMessageFactory<TInput>;
  /** どのメッセージをレスポンスとみなすかを決定する述語関数です。この条件を最初に満たしたメッセージがレスポンスになります。 */
  selector: (data: TOutput) => boolean;

  /** レスポンスを待つ最大時間をミリ秒単位で指定します。省略した場合は無制限に待ちます。 */
  timeout?: number;

  /** レスポンスの待機またはリクエストの再送を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** レスポンスを待つまでの間に再接続が発生した場合のための再送戦略を指定します。 */
  retry?: UniplsRetryStrategy<TInput, TOutput>;
}

/**
 * {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の再送戦略を指定します。
 * - `fail`: リクエストを再送せず、例外終了します。
 * - `wait`: 再接続後にリクエストは再送しませんが、レスポンスを待機し続けます。
 * - `resend`: 再度同じリクエストを送信します。
 * - `recover`: 再接続後の回復方法を細かく制御します。
 */
export type UniplsRetryStrategy<TInput = WebSocketData, TOutput = WebSocketData> =
  | UniplsRetryPreset
  | UniplsRecoverStrategy<TInput, TOutput>;

export type UniplsRetryPreset = "fail" | "wait" | "resend";

/**
 * {@link Unipls.next|unipls.next()} または {@link Unipls.listen|unipls.listen()} で利用可能な、drop 時の待機継続戦略です。
 */
export type UniplsDropRetryStrategy = "fail" | "wait";

export interface UniplsRecoverContext<TInput = WebSocketData, TOutput = WebSocketData> {
  query: UniplsMessageFactory<TInput>;
  selector: (data: TOutput) => boolean;
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

export type UniplsRecoveryDecision<TInput = WebSocketData, TOutput = WebSocketData> =
  | Exclude<UniplsRetryPreset, "resend">
  | "resend"
  | UniplsRecoveryPlan<TInput, TOutput>
  | void;

export interface UniplsRecoverStrategy<TInput = WebSocketData, TOutput = WebSocketData> {
  recover: (
    ctx: UniplsRecoverContext<TInput, TOutput>,
  ) => UniplsRecoveryDecision<TInput, TOutput> | Promise<UniplsRecoveryDecision<TInput, TOutput>>;
}

/** {@link Unipls.subscribe|unipls.subscribe()} の必須の第2引数で、`subscribe()` の挙動を制御します。 */
export interface UniplsSubscribeParams<TInput = WebSocketData, TOutput = WebSocketData> {
  query: UniplsMessageFactory<TInput>;

  /** どのメッセージを購読の対象とみなすかを決定する述語関数です。この条件を満たしたすべてのメッセージが購読の対象になります。 */
  selector: (data: TOutput) => boolean;

  /** どのメッセージを購読の終端とみなすかを決定する述語関数です。この条件を最初に満たしたメッセージが購読の終端になります。 */
  terminator?: (data: TOutput) => boolean;

  /** 購読の終端を待つ最大時間をミリ秒単位で指定します。 */
  timeout?: number;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** 購読の終端を待つまでの間に再接続が発生した場合のための再送戦略を指定します。 */
  retry?: UniplsRetryStrategy<TInput, TOutput>;
}
