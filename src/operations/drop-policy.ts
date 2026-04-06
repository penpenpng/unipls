import { UniplsDroppedError } from '../errors.ts';
import type {
  UniplsDropRetryStrategy,
  UniplsRetrySetupContext,
  UniplsRetrySetupFunction,
  UniplsRetryStrategy,
} from '../unipls.interface.ts';

export function createDropWaitHandler(params: {
  reconnectable: boolean;
  retry?: UniplsDropRetryStrategy;
  isDone: () => boolean;
  onFatal: (error: unknown) => void;
}): () => void {
  return () => {
    if (params.isDone()) {
      return;
    }

    const retry = params.retry ?? 'keep-listening';
    if (!params.reconnectable || retry === 'never') {
      params.onFatal(new UniplsDroppedError());
    }
  };
}

export function createRetryingDropHandler<TInput, TOutput>(params: {
  retry?: UniplsRetryStrategy<TInput, TOutput>;
  isDone: () => boolean;
  onFatal: (error: unknown) => void;
  onReconnected: UniplsRetrySetupContext<TInput, TOutput>['onReconnected'];
  getData: () => UniplsRetrySetupContext<TInput, TOutput>['data'];
  getSelector: () => UniplsRetrySetupContext<TInput, TOutput>['selector'];
}): () => void {
  let retryRegistered = false;

  return () => {
    if (params.isDone() || retryRegistered) {
      return;
    }
    retryRegistered = true;

    if (params.retry === undefined || params.retry === 'never') {
      params.onFatal(new UniplsDroppedError());
      return;
    }

    const setupRetry = getRetrySetupFunction(params.retry);

    try {
      setupRetry({
        onReconnected: params.onReconnected,
        data: params.getData(),
        selector: params.getSelector(),
      });
    } catch (err) {
      params.onFatal(err ?? new UniplsDroppedError());
    }
  };
}

export function getRetrySetupFunction<TInput, TOutput>(
  retry?: UniplsRetryStrategy<TInput, TOutput>,
): UniplsRetrySetupFunction<TInput, TOutput> {
  if (retry === 're-request') {
    return ({ onReconnected, data, selector }) => {
      onReconnected(async ({ request }) => {
        await request(data, { selector });
      });
    };
  }

  if (retry === 'keep-listening') {
    return ({ onReconnected }) => {
      onReconnected(() => {});
    };
  }

  return retry ?? (() => {});
}
