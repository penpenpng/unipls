import { type ReconnectionContext, type UniplsReconnector } from '../..';
import { AwaitableQueue } from './awaitable-queue';

export const immediateReconnector: UniplsReconnector = {
  reconnect: () => true,
};

export class TestReconnector implements UniplsReconnector {
  readonly #queue = new AwaitableQueue<
    PromiseWithResolvers<boolean> & ReconnectionContext
  >();

  async reconnect(ctx: ReconnectionContext) {
    const reconnect = Promise.withResolvers<boolean>();
    this.#queue.enqueue({ ...reconnect, ...ctx });

    return reconnect.promise;
  }

  dequeueReconnect() {
    return this.#queue.dequeue();
  }
}
