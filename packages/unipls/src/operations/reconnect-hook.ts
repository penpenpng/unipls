import type { EventBus } from "../event-bus.ts";
import type { UniplsReconnectEvent } from "../reconnector/reconnector.ts";
import type { UniplsMessageFactory } from "../unipls.interface.ts";

export function createOnReconnectedHandler<
  TInput,
  TOutput,
  TEvents extends {
    reconnect: UniplsReconnectEvent;
  },
>(params: {
  events: Pick<EventBus<TEvents>, "once">;
  isDone: () => boolean;
  reset: () => void;
  request: (
    data: UniplsMessageFactory<TInput>,
    params: { selector: (data: TOutput) => boolean },
  ) => Promise<void> | void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
}): (
  callback: (ctx: {
    request: (
      data: UniplsMessageFactory<TInput>,
      params: { selector: (data: TOutput) => boolean },
    ) => Promise<void> | void;
    reconnection: UniplsReconnectEvent;
  }) => Promise<void> | void,
) => void {
  return (callback) => {
    params.events.once("reconnect", async (reconnection) => {
      if (params.isDone()) {
        params.onSettled?.();
        return;
      }

      params.reset();

      try {
        await callback({
          request: params.request,
          reconnection,
        });
      } catch (err) {
        params.onError(err ?? new Error("Recovery callback failed"));
      } finally {
        params.onSettled?.();
      }
    });
  };
}
