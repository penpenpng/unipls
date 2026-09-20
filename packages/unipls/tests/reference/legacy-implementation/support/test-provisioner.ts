// Non-normative support for the historical references in this directory tree.
import type { WebSocketData } from "../../../../src/index.ts";
import type {
  UniplsProvisionerObject,
  UniplsProvisioningContext,
} from "../../../../src/unipls.interface.ts";
import { AwaitableQueue } from "./awaitable-queue";

export class TestProvisioner<
  TInput = WebSocketData,
  TOutput = WebSocketData,
> implements UniplsProvisionerObject<TInput, TOutput> {
  #queue = new AwaitableQueue<
    PromiseWithResolvers<void> & UniplsProvisioningContext<TInput, TOutput>
  >();

  async setup(ctx: UniplsProvisioningContext<TInput, TOutput>) {
    const provision = Promise.withResolvers<void>();
    this.#queue.enqueue({ ...provision, ...ctx });

    await provision.promise;
  }

  dequeueContext() {
    return this.#queue.dequeue();
  }
}
