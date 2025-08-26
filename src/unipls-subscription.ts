import type { WebSocketData } from './types.ts';

export class UniplsSubscription {
  unsubscribe(): void {}
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

export interface SubscriberOperator<TInput = WebSocketData> {
  unsubscribe(): void;
  cast(data: TInput): void;
}

export type SubscriptionEndReason =
  | 'closed'
  | 'aborted'
  | 'unsubscribed'
  | 'terminated'
  | 'fatal-error';
