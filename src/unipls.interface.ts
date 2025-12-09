import type {
  SessionId,
  WebSocketConstructor,
  WebSocketData,
} from './types.ts';
import { type UniplsSubscriber } from './unipls-subscription.ts';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Used by JSDoc
import type { Unipls } from './unipls.ts';

export interface UniplsParams<TInput = WebSocketData, TOutput = WebSocketData> {
  url: string;
  serializer?: (data: TInput) => WebSocketData;
  deserializer?: (data: WebSocketData) => TOutput;
  WebSocket?: WebSocketConstructor;
  timeout?: number;
}

/**
 * {@link Unipls.open|unipls.connect()} の任意の引数で、{@link UniplsReconnector} による再接続を含む WebSocket 接続の成功直後に実行されます。
 *
 * @remarks
 * 初期化が終了したら必ず {@link UniplsProvisioningContext.done|done()} を呼び出さなければなりません。
 */
export type UniplsProvisioner<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> = (ctx: UniplsProvisioningContext<TInput, TOutput>) => void;

/**
 * {@link UniplsProvisioner} の引数で、{@link Unipls} の初期化を行うためのコンテキストを表します。
 */
export interface UniplsProvisioningContext<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> {
  /**
   * {@link Unipls.cast|unipls.cast()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsCastOptions.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsCastOptions.recast|recast} を指定することはできません。送信に失敗したときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  cast(data: TInput): Promise<void>;

  /**
   * {@link Unipls.request|unipls.request()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsRequestParams.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsRequestParams.retry|retry} を指定することはできません。送信に失敗したときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  request(
    data: TInput,
    params: Omit<UniplsRequestParams<TInput, TOutput>, 'signal' | 'retry'>,
  ): Promise<TOutput>;

  /**
   * {@link Unipls.listen|unipls.listen()} とほとんど同様ですが、以下が異なります:
   * - {@link UniplsListenOptions.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsListenOptions.retry|retry} を指定することはできません。購読が中断されたときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  listen(
    params: UniplsSubscriber<TOutput> &
      Omit<UniplsListenOptions<TOutput>, 'signal' | 'retry'>,
  ): void;

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsSubscribeParams.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsSubscribeParams.retry|retry} を指定することはできません。送信に失敗したときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  subscribe(
    data: TInput,
    params: UniplsSubscriber<TOutput> &
      Omit<UniplsSubscribeParams<TInput, TOutput>, 'signal' | 'retry'>,
  ): () => void;

  /** 初期化が完了したことを {@link Unipls} に通知します。この関数は初期化完了時に必ず呼び出されなければなりません。 */
  done(): void;

  /** 現在のセッションを表します。 */
  session: SessionId;

  /** これが現在のセッションの中での最初の初期化ならば `true`、そうでなければ `false` を与えます。 */
  isSessionBeginning: boolean;
}

export interface UniplsNextParams<TOutput = WebSocketData> {
  /** どのメッセージをレスポンスとみなすかを決定する述語関数です。この条件を最初に満たしたメッセージがレスポンスになります。 */
  selector: (data: TOutput) => boolean;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** レスポンス待機中に予期しない切断が発生した場合、再接続後もレスポンスを待機するかを指定します。 */
  stopListeningOnDisconnected?: boolean;
}

/** {@link Unipls.listen|unipls.listen()} の必須の第2引数で、`listen()` の挙動を制御します。 */
export interface UniplsListenOptions<TOutput = WebSocketData> {
  /** どのメッセージを購読の対象とみなすかを決定する述語関数です。この条件を満たしたすべてのメッセージが購読の対象になります。 */
  selector?: (data: TOutput) => boolean;

  /** どのメッセージを購読の終端とみなすかを決定する述語関数です。この条件を最初に満たしたメッセージが購読の終端になります。 */
  terminator?: (data: TOutput) => boolean;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** 購読中に予期しない切断が発生した場合、再接続後も購読を継続するかを指定します。 */
  stopListeningOnDropped?: boolean;
}

/**
 * {@link Unipls.cast|unipls.cast()} の任意の第2引数で、`cast()` の挙動を制御します。
 */
export interface UniplsCastOptions<TInput = WebSocketData> {
  /**
   * 再接続処理中に {@link Unipls.cast|unipls.cast()} が実行された場合の再送戦略を指定します。
   *
   * @default "always"
   */
  recast?: UniplsRecastStrategy<TInput>;

  /**
   * 再送を中断するための {@link AbortSignal} を指定します。
   */
  signal?: AbortSignal;
}

/**
 * {@link Unipls.cast|unipls.cast()} の再送戦略を表します。
 *
 * - `never`: 再送しません。`({ abort }) => { abort(); }` と同等です。
 * - `always`: 同内容を再送します。`({ data, cast, done }) => { cast(data); done(); }` と同等です。
 * - `RecastFunction`: 再送の方法を {@link UniplsRecastFunction} によって細かく制御します。
 */
export type UniplsRecastStrategy<TInput = WebSocketData> =
  | 'never'
  | 'always'
  | UniplsRecastFunction<TInput>;

/**
 * {@link Unipls.cast|unipls.cast()} の再送戦略を定義する関数を表します。
 *
 * @remarks
 * 再送処理が完了、または中断されたことを示すために {@link UniplsRecastContext.done|done()} または {@link UniplsRecastContext.abort|abort()} のいずれかを必ず呼び出さなければなりません。
 */
export type UniplsRecastFunction<TInput = WebSocketData> = (
  ctx: UniplsRecastContext<TInput>,
) => void;

/**
 * {@link UniplsRecastFunction} の引数で、再送の方法を制御するためのコンテキストを表します。
 */
export interface UniplsRecastContext<TInput = WebSocketData> {
  /** 直前に送信が試行されたデータを表します。すなわち、初回の再送では {@link Unipls.cast|unipls.cast()} の引数に等しく、それ以降の再送では直前の再送で送信を試行したデータに等しいです。 */
  data: TInput;

  /** 再送を試行します。 */
  cast(data: TInput): void;

  /** 再送処理を完了したことを {@link Unipls} に通知します。 */
  done(): void;

  /** 再送処理を中断したことを {@link Unipls} に通知します。 */
  abort(error?: unknown): void;
}

/** {@link Unipls.request|unipls.request()} の必須の第2引数で、`request()` の挙動を制御します。 */
export interface UniplsRequestParams<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> {
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
 * - `never`: リクエストを再送せず、例外終了します。`({ abort }) => { abort(); }` と同等です。
 * - `re-request`: 再度同じリクエストを送信します。`({ data, selector, request, done }) => { request(data, { selector }); done(); }` と同等です。
 * - `keep-listening`: 再接続後にリクエストは再送しませんが、レスポンスを待機し続けます。`({ done }) => { done(); }` と同等です。
 * - `RetryFunction`: 再送の方法を {@link UniplsRetrySetupFunction} によって細かく制御します。
 */
export type UniplsRetryStrategy<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> =
  | 'never'
  | 're-request'
  | 'keep-listening'
  | UniplsRetrySetupFunction<TInput, TOutput>;

/**
 * {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の再送戦略を定義する関数を表します。
 *
 * @remarks
 * 再送処理が完了、または中断されたことを示すために {@link UniplsRecastContext.done|done()} または {@link UniplsRecastContext.abort|abort()} のいずれかを必ず呼び出さなければなりません。
 */
export type UniplsRetrySetupFunction<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> = (ctx: UniplsRetrySetupContext<TInput, TOutput>) => void;

/** {@link UniplsRetrySetupFunction} の引数で、再送の方法を制御するためのコンテキストを表します。 */
export interface UniplsRetrySetupContext<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> {
  onReconnected: (
    callback: (ctx: UniplsRetryContext<TInput, TOutput>) => void,
  ) => void;

  /** 直前に送信したデータを表します。すなわち、初回の再送では {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の引数に等しく、それ以降の再送では直前の再送で送信したデータに等しいです。 */
  data: TInput;

  /** 直前に指定したセレクタを表します。すなわち、初回の再送では {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の引数に等しく、それ以降の再送では直前の再送で指定したセレクタに等しいです。 */
  selector: (data: TOutput) => boolean;

  /** 再送処理を中断したことを {@link Unipls} に通知します。 */
  abort(error?: unknown): void;
}

/** {@link Unipls.subscribe|unipls.subscribe()} の必須の第2引数で、`subscribe()` の挙動を制御します。 */
export interface UniplsSubscribeParams<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> {
  /** どのメッセージを購読の対象とみなすかを決定する述語関数です。この条件を満たしたすべてのメッセージが購読の対象になります。 */
  selector: (data: TOutput) => boolean;

  /** どのメッセージを購読の終端とみなすかを決定する述語関数です。この条件を最初に満たしたメッセージが購読の終端になります。 */
  terminator?: (data: TOutput) => boolean;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** 購読の終端を待つまでの間に再接続が発生した場合のための再送戦略を指定します。 */
  retry?: UniplsRetryStrategy<TInput, TOutput>;
}
