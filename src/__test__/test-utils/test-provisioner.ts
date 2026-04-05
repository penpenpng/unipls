import type { UniplsProvisioner, WebSocketData } from '../..';
import { AwaitableQueue } from './awaitable-queue';

export const createTestProvisioner = <
  TInput = WebSocketData,
  TOutput = WebSocketData,
>() => {
  const queue = new AwaitableQueue<PromiseWithResolvers<void>>();

  const provisioner: UniplsProvisioner<TInput, TOutput> = async () => {
    const provision = Promise.withResolvers<void>();
    queue.enqueue(provision);

    await provision.promise;
  };

  // FIXME: クラス形式の provisioner もサポートすればこういうことしなくてよくなるかも
  return Object.assign(provisioner, {
    dequeueProvisioner: () => queue.dequeue(),
  });
};
