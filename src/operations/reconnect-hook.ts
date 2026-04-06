import type { EventBus } from '../event-bus.ts';
import { UniplsDroppedError } from '../errors.ts';
import type { UniplsReconnectEvent } from '../reconnector/reconnector.ts';
import type { UniplsRetrySetupContext } from '../unipls.interface.ts';

export function createOnReconnectedHandler<TInput, TOutput, TEvents extends {
  reconnect: UniplsReconnectEvent;
}>(params: {
  events: Pick<EventBus<TEvents>, 'once'>;
  isDone: () => boolean;
  reset: () => void;
  request: (
    data: UniplsRetrySetupContext<TInput, TOutput>['data'],
    params: { selector: UniplsRetrySetupContext<TInput, TOutput>['selector'] },
  ) => void;
  onError: (error: unknown) => void;
}): UniplsRetrySetupContext<TInput, TOutput>['onReconnected'] {
  return (callback) => {
    params.events.once('reconnect', async (reconnection) => {
      if (params.isDone()) {
        return;
      }

      params.reset();

      try {
        await callback({
          request: params.request,
          reconnection,
        });
      } catch (err) {
        params.onError(err ?? new UniplsDroppedError());
      }
    });
  };
}
