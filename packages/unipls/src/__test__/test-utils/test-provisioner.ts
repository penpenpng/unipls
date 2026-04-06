import type { WebSocketData } from "../..";
import type { UniplsProvisionerObject, UniplsProvisioningContext } from "../../unipls.interface";
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
