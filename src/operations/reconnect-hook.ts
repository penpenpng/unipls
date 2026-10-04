import type { UniplsMessageFactory } from "../client/unipls.interface.ts";
import type { UniplsReconnectEvent } from "../reconnectors/reconnector.ts";
import type { EventBus } from "../shared/event-bus.ts";

export function createOnReconnectedHandler<
  TInput,
  TOutput,
  TEvents extends {
    reconnect: UniplsReconnectEvent;
  },
>(params: {
  events: Pick<EventBus<TEvents>, "on">;
  isDone: () => boolean;
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
    params.events.on(
      "reconnect",
      async (reconnection) => {
        if (params.isDone()) {
          params.onSettled?.();
          return;
        }

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
      },
      { once: true },
    );
  };
}
