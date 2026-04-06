import {
  type ReconnectionContext,
  type UniplsReconnector,
  type UniplsReconnectorActions,
} from "../..";
import { AwaitableQueue } from "./awaitable-queue";

export class TestReconnector implements UniplsReconnector {
  readonly #queue = new AwaitableQueue<UniplsReconnectorActions & ReconnectionContext>();

  setup({ reconnect, cancel }: UniplsReconnectorActions, ctx: ReconnectionContext) {
    this.#queue.enqueue({ reconnect, cancel, ...ctx });
  }

  dequeueContext() {
    return this.#queue.dequeue();
  }
}
