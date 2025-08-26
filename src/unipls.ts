/** WebSocket によって送受信することができるデータを表します。 */
export type WebSocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

/**
 * {@link Unipls.connect|unipls.connect()} の任意の引数で、{@link UniplsReconnector} による再接続を含む WebSocket 接続の成功直後に実行されます。
 *
 * @remarks
 * 初期化が終了したら必ず {@link UniplsInitializationContext.done|done()} を呼び出さなければなりません。
 */
export type UniplsInitializer<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> = (ctx: UniplsInitializationContext<TInput, TOutput>) => void;

/**
 * {@link UniplsInitializer} の引数で、{@link Unipls} の初期化を行うためのコンテキストを表します。
 */
export interface UniplsInitializationContext<
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
   * - {@link UniplsListenParams.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsListenParams.retry|retry} を指定することはできません。購読が中断されたときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  listen(
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: Omit<UniplsListenParams<TOutput>, 'signal' | 'retry'>,
  ): void;

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} とほとんど同様ですが、以下が異なります:
   * - この関数は初期化完了前でもただちにデータを送信します。
   * - {@link UniplsSubscribeParams.signal|signal} を指定することはできません。この関数は {@link Unipls.close|unipls.close()} によって接続が中断されたときにのみ中断されます。
   * - {@link UniplsSubscribeParams.retry|retry} を指定することはできません。送信に失敗したときには初期化が失敗したものとみなされ、{@link UniplsReconnector} による再接続が試みられます。
   */
  subscribe(
    data: TInput,
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: Omit<UniplsSubscribeParams<TInput, TOutput>, 'signal' | 'retry'>,
  ): () => void;

  /** 初期化が完了したことを {@link Unipls} に通知します。この関数は初期化完了時に必ず呼び出されなければなりません。 */
  done(): void;

  /** 現在のセッションを表します。 */
  session: SessionId;

  /** これが現在のセッションの中での最初の初期化ならば `true`、そうでなければ `false` を与えます。 */
  isSessionBeginning: boolean;

  /** 再接続時にのみ、再送コンテストを表します。{@link UniplsReconnector.reconnect|reconnector.reconnect()} の引数に与えられるものと同一です。*/
  reconnection?: ReconnectionContext;
}

/**
 * セッションに与えられる一意な識別子です。セッションとは {@link Unipls.connect|unipls.connect()} が呼び出されてから {@link Unipls.close|unipls.close()} が呼び出されるまでの間を指します。
 */
export type SessionId = number;

/**
 * {@link Unipls.cast|unipls.cast()} の任意の第2引数で、`cast()` の挙動を制御します。
 */
export interface UniplsCastOptions<TInput = WebSocketData> {
  /**
   * 再接続処理中に {@link Unipls.cast|unipls.cast()} が実行された場合の再送戦略を指定します。
   *
   * @default "always"
   */
  recast?: RecastStrategy<TInput>;

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
 * - `RecastFunction`: 再送の方法を {@link RecastFunction} によって細かく制御します。
 */
export type RecastStrategy<TInput = WebSocketData> =
  | 'never'
  | 'always'
  | RecastFunction<TInput>;

/**
 * {@link Unipls.cast|unipls.cast()} の再送戦略を定義する関数を表します。
 *
 * @remarks
 * 再送処理が完了、または中断されたことを示すために {@link RecastContext.done|done()} または {@link RecastContext.abort|abort()} のいずれかを必ず呼び出さなければなりません。
 */
export type RecastFunction<TInput = WebSocketData> = (
  ctx: RecastContext<TInput>,
) => void;

/**
 * {@link RecastFunction} の引数で、再送の方法を制御するためのコンテキストを表します。
 */
export interface RecastContext<TInput = WebSocketData> {
  /** 再送コンテストを表します。{@link UniplsReconnector.reconnect|reconnector.reconnect()} の引数に与えられるものと同一です。*/
  reconnection: ReconnectionContext;

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
  retry?: RetryStrategy<TInput, TOutput>;
}

/**
 * {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の再送戦略を指定します。
 * - `never`: リクエストを再送せず、例外終了します。`({ abort }) => { abort(); }` と同等です。
 * - `re-request`: 再度同じリクエストを送信します。`({ data, selector, request, done }) => { request(data, { selector }); done(); }` と同等です。
 * - `keep-listening`: 再接続後にリクエストは再送しませんが、レスポンスを待機し続けます。`({ done }) => { done(); }` と同等です。
 * - `RetryFunction`: 再送の方法を {@link RetryFunction} によって細かく制御します。
 */
export type RetryStrategy<TInput = WebSocketData, TOutput = WebSocketData> =
  | 'never'
  | 're-request'
  | 'keep-listening'
  | RetryFunction<TInput, TOutput>;

/**
 * {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の再送戦略を定義する関数を表します。
 *
 * @remarks
 * 再送処理が完了、または中断されたことを示すために {@link RecastContext.done|done()} または {@link RecastContext.abort|abort()} のいずれかを必ず呼び出さなければなりません。
 */
export type RetryFunction<TInput = WebSocketData, TOutput = WebSocketData> = (
  ctx: RetryContext<TInput, TOutput>,
) => void;

/** {@link RetryFunction} の引数で、再送の方法を制御するためのコンテキストを表します。 */
export interface RetryContext<TInput = WebSocketData, TOutput = WebSocketData> {
  /** 再送コンテストを表します。{@link UniplsReconnector.reconnect|reconnector.reconnect()} の引数に与えられるものと同一です。*/
  reconnection: ReconnectionContext;

  /** 直前に送信したデータを表します。すなわち、初回の再送では {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の引数に等しく、それ以降の再送では直前の再送で送信したデータに等しいです。 */
  data: TOutput;

  /** 直前に指定したセレクタを表します。すなわち、初回の再送では {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の引数に等しく、それ以降の再送では直前の再送で指定したセレクタに等しいです。 */
  selector: (data: TOutput) => boolean;

  /** 再送を試行します。 */
  request(
    data: TInput,
    params: Pick<UniplsRequestParams<TInput, TOutput>, 'selector'>,
  ): void;

  /** 再送処理を完了したことを {@link Unipls} に通知します。 */
  done(): void;

  /** 再送処理を中断したことを {@link Unipls} に通知します。 */
  abort(error?: unknown): void;
}

/** {@link Unipls.listen|unipls.listen()} の必須の第2引数で、`listen()` の挙動を制御します。 */
export interface UniplsListenParams<TOutput = WebSocketData> {
  /** どのメッセージを購読の対象とみなすかを決定する述語関数です。この条件を満たしたすべてのメッセージが購読の対象になります。 */
  selector: (data: TOutput) => boolean;

  /** どのメッセージを購読の終端とみなすかを決定する述語関数です。この条件を最初に満たしたメッセージが購読の終端になります。 */
  terminator?: (data: TOutput) => boolean;

  /** 購読を中断するための {@link AbortSignal} を指定します。 */
  signal?: AbortSignal;

  /** 購読中に再接続が発生した場合、再接続後も購読を継続するかを指定します。 */
  stopListeningOnReconnect?: boolean;
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
  retry?: RetryStrategy<TInput, TOutput>;
}

export interface UniplsParams<TInput = WebSocketData, TOutput = WebSocketData> {
  url: string;
  serializer?: (data: TInput) => WebSocketData;
  deserializer?: (data: WebSocketData) => TOutput;
  reconnector?: UniplsReconnector;
  WebSocket?: WebSocket;
}

/** {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の必須の引数で、購読者を定義します。 */
export interface UniplsSubscriber<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> {
  /** 購読の対象となるメッセージを観測したときに実行されるコールバックを指定します。 */
  onMessage?: (data: TOutput, operations: SubscriberOperator<TInput>) => void;

  /** 購読の終端となるメッセージを観測したときに実行されるコールバックを指定します。 */
  onTerminated?: (data: TOutput, operator: SubscriberOperator<TInput>) => void;

  /** 購読の対象となるメッセージがエラーを引き起こしたときに実行されるコールバックを指定します。このエラーは、典型的には `deserializer` によって発生し得ます。 */
  onError?: (error: unknown, operator: SubscriberOperator<TInput>) => void;

  /** 購読が終了したときに実行されるコールバックを指定します。 */
  finally?: (ctx: SubscriptionFinalizationContext<TInput>) => void;
}

export interface SubscriptionFinalizationContext<TInput = WebSocketData> {
  /** 購読が終了した理由を表します。 */
  reason: SubscriptionEndReason;

  /** `reason === 'fatal-error'` の場合のみ、購読が終了した原因となったエラーを表します。 */
  error?: unknown;

  /** WebSocket 接続がまだ維持されている場合のみ、{@link Unipls.cast|unipls.cast()} を呼び出す関数を与えます。 */
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

export class UniplsError extends Error {}
export class UniplsClosedError extends UniplsError {}
export class UniplsTimeoutError extends UniplsError {}
export class UniplsAbortedError extends UniplsError {}
export class UniplsDuplicatedConnectionError extends UniplsError {}

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

  /**
   * WebSocket 接続を確立します。
   *
   * @param {UniplsInitializer} initializer WebSocket 接続成功後の初期化処理を定義します。省略した場合は `({ done }) => done()` と同等になります。
   * @returns {Promise<void>} WebSocket 接続と初期化が完了したことを表す Promise を返します。
   *
   * @throws {UniplsDuplicatedConnectionError} WebSocket が既に接続されているか、接続を試行中の場合に例外を投げます。
   *
   * @remarks
   * 初期化が終了したら必ず {@link UniplsInitializationContext.done|done()} を呼び出さなければなりません。
   */
  connect(initializer?: UniplsInitializer): Promise<void> {}

  /**
   * WebSocket 接続を切断します。この切断にともなう再接続は行われません。既に切断されている場合は何もしません。
   */
  close(): void {}

  /**
   * 0-input 1-output の通信を行います。
   *
   * @throws {UniplsClosedError}
   * @throws {UniplsAbortedError}
   * @throws {UniplsTimeoutError}
   */
  next(): Promise<T> {}

  /**
   * 0-input N-output の通信を行います。
   *
   * @returns {UniplsSubscription} 購読を表すオブジェクトを返します。
   *
   * @throws {UniplsClosedError}
   */
  listen(
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsListenParams<TOutput>,
  ): UniplsSubscription {}

  /**
   * 1-input 0-output の通信を行います。{@link UniplsInitializer} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {Promise<void>} WebSocket 接続が確立している間にデータを送信した場合に resolve される Promise を返します。
   *
   * @throws {UniplsClosedError}
   * @throws {UniplsAbortedError}
   */
  cast(data: TInput, options?: UniplsCastOptions<TInput>): Promise<void> {}

  /**
   * {@link Unipls.cast|unipls.cast()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  castForce(data: TInput, options?: UniplsCastOptions<TInput>): Promise<void> {}

  /**
   * 1-input 1-output の通信を行います。{@link UniplsInitializer} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {Promise<T>} レスポンスを観測したときに resolve される Promise を返します。
   *
   * @throws {UniplsClosedError}
   * @throws {UniplsAbortedError}
   * @throws {UniplsTimeoutError}
   */
  request<T = TOutput>(
    data: TInput,
    params: UniplsRequestParams<TInput, TOutput>,
  ): Promise<T> {}

  /**
   * {@link Unipls.request|unipls.request()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  requestForce<T = TOutput>(
    data: TInput,
    params: UniplsRequestParams<TInput, TOutput>,
  ): Promise<T> {}

  /**
   * 1-input N-output の通信を行います。{@link UniplsInitializer} による初期化が終了していない場合、初期化が終了するまで送信は延期されます。
   *
   * @returns {UniplsSubscription} 購読を表すオブジェクトを返します。
   *
   * @throws {UniplsClosedError}
   * @throws {UniplsAbortedError}
   */
  subscribe(
    data: TInput,
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): UniplsSubscription {}

  /**
   * {@link Unipls.subscribe|unipls.subscribe()} と同じですが、初期化が終了していなくてもただちに送信を試みます。接続試行中の場合は接続の完了まで待って、初期化前に送信します。
   */
  subscribeForce(
    data: TInput,
    subscriber: UniplsSubscriber<TInput, TOutput>,
    params: UniplsSubscribeParams<TInput, TOutput>,
  ): UniplsSubscription {}
}

interface ReconnectionContext {
  /** 現在のセッションを表します。 */
  session: SessionId;

  /** open イベントを挟まずに何回連続で再接続を試行しているかを表します。 */
  streak: number;

  /** この再接続よりも前に試行した再接続の中で最も新しい試行を行った時刻を表します。 */
  lastAttemptedAt?: number;

  /** この再接続を引き起こしたエラーがある場合、それを表します。 */
  error?: unknown;

  /** 現在のセッションで行われた再接続のリストを表します。この値は変更可能です。 */
  sessionAttempts: ReconnectionAttempt[];

  /** すべてのセッションで行われた再接続のリストを表します。この値は変更可能です。 */
  allAttempts: ReconnectionAttempt[];

  /** 再接続を試行します。 */
  reconnect(): void;

  /** 再接続を中断します。 */
  abort(): void;
}

interface ReconnectionAttempt {
  session: SessionId;
  streak: number;
  attemptedAt: number;
  error?: unknown;
}

export abstract class UniplsReconnector {
  constructor() {}

  abstract reconnect(ctx: ReconnectionContext): Promise<void>;
}

class UniplsSubscription {
  unsubscribe(): void {}
}
