import type { WebSocketData } from '../..';
import type {
  SubscriptionFinalizationContext,
  UniplsSubscriber,
} from '../../async-results';
import { AwaitableQueue } from './awaitable-queue';

export class TestSubscriber<TOutput = WebSocketData>
  implements UniplsSubscriber<TOutput>
{
  readonly messages = new AwaitableQueue<TOutput>();
  readonly errors = new AwaitableQueue<unknown>();
  #termination = Promise.withResolvers<TOutput>();
  #unsubscription = Promise.withResolvers<void>();
  #finalization = Promise.withResolvers<SubscriptionFinalizationContext>();

  constructor(private subscriber?: UniplsSubscriber<TOutput>) {
    void this.#termination.promise.catch(() => {});
  }

  get termination() {
    return this.#termination.promise;
  }

  get unsubscription() {
    return this.#unsubscription.promise;
  }

  get finalization() {
    return this.#finalization.promise;
  }

  onMessage = (data: TOutput) => {
    this.subscriber?.onMessage?.(data);
    this.messages.enqueue(data);
  };

  onTerminated = (data: TOutput) => {
    this.subscriber?.onTerminated?.(data);
    this.#termination.resolve(data);
  };

  onError = (error: unknown) => {
    this.subscriber?.onError?.(error);
    this.errors.enqueue(error);
  };

  onFatalError = (error: unknown) => {
    this.subscriber?.onFatalError?.(error);
    this.#termination.reject(error);
  };

  finally = (ctx: SubscriptionFinalizationContext) => {
    this.subscriber?.finally?.(ctx);
    this.#finalization.resolve(ctx);
  };

  onUnsubscribed = () => {
    this.subscriber?.onUnsubscribed?.();
    this.#unsubscription.resolve();
  };
}
