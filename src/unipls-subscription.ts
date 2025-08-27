import type { WebSocketData } from './types.ts';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Used by JSDoc
import type { Unipls } from './unipls.ts';

export class UniplsSubscription {
  unsubscribe(): void {}
}

/** {@link Unipls.listen|unipls.listen()} または {@link Unipls.subscribe|unipls.subscribe()} の必須の引数で、購読者を定義します。 */
export interface UniplsSubscriber<TOutput = WebSocketData> {
  /** 購読の対象となるメッセージを観測したときに実行されるコールバックを指定します。 */
  onMessage?: (data: TOutput) => void;

  /** 購読の終端となるメッセージを観測したときに実行されるコールバックを指定します。 */
  onTerminated?: (data: TOutput) => void;

  /** 購読の対象となるメッセージがエラーを引き起こしたときに実行されるコールバックを指定します。このエラーは、典型的には `deserializer` によって発生し得ます。 */
  onError?: (error: unknown) => void;

  /** 購読が終了したときに実行されるコールバックを指定します。 */
  finally?: (ctx: SubscriptionFinalizationContext) => void;
}

export interface SubscriptionFinalizationContext {
  /** 購読が終了した理由を表します。 */
  reason: SubscriptionEndReason;

  /** `reason === 'fatal-error'` の場合のみ、購読が終了した原因となったエラーを表します。 */
  error?: unknown;
}

export type SubscriptionEndReason =
  | 'closed'
  | 'aborted'
  | 'unsubscribed'
  | 'terminated'
  | 'fatal-error';
