import { UniplsDroppedError } from '../errors.ts';
import type { UniplsReconnectEvent } from '../reconnector/reconnector.ts';
import type {
  UniplsDropRetryStrategy,
  UniplsMessageFactory,
  UniplsRecoveryDecision,
  UniplsRetryStrategy,
} from '../unipls.interface.ts';

type RetryRequest<TInput, TOutput> = (
  data: UniplsMessageFactory<TInput>,
  params: { selector: (data: TOutput) => boolean },
) => Promise<void> | void;

type OnReconnected<TInput, TOutput> = (
  callback: (ctx: {
    request: RetryRequest<TInput, TOutput>;
    reconnection: UniplsReconnectEvent;
  }) => Promise<void> | void,
) => void;

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

    const retry = params.retry ?? 'wait';
    if (!params.reconnectable || retry === 'fail') {
      params.onFatal(new UniplsDroppedError());
    }
  };
}

export function createRetryingDropHandler<TInput, TOutput>(params: {
  reconnectable: boolean;
  retry?: UniplsRetryStrategy<TInput, TOutput>;
  isDone: () => boolean;
  onFatal: (error: unknown) => void;
  onReconnected: OnReconnected<TInput, TOutput>;
  getQuery: () => UniplsMessageFactory<TInput>;
  getSelector: () => (data: TOutput) => boolean;
}): () => void {
  let waitingForReconnect = false;

  return () => {
    if (params.isDone() || waitingForReconnect) {
      return;
    }

    const retry = params.retry ?? 'fail';
    if (!params.reconnectable || retry === 'fail') {
      params.onFatal(new UniplsDroppedError());
      return;
    }

    waitingForReconnect = true;
    const query = params.getQuery();
    const selector = params.getSelector();

    params.onReconnected(async ({ request, reconnection }) => {
      waitingForReconnect = false;

      if (retry === 'wait') {
        return;
      }

      if (retry === 'resend') {
        await request(query, { selector });
        return;
      }

      const decision = await retry.recover({
        query,
        selector,
        reconnection,
      });

      await runRecoveryDecision(decision, {
        request,
        query,
        selector,
      });
    });
  };
}

async function runRecoveryDecision<TInput, TOutput>(
  decision: UniplsRecoveryDecision<TInput, TOutput>,
  params: {
    request: RetryRequest<TInput, TOutput>;
    query: UniplsMessageFactory<TInput>;
    selector: (data: TOutput) => boolean;
  },
): Promise<void> {
  if (decision === undefined || decision === 'wait') {
    return;
  }

  if (decision === 'fail') {
    throw new UniplsDroppedError();
  }

  if (decision === 'resend') {
    await params.request(params.query, {
      selector: params.selector,
    });
    return;
  }

  await params.request(decision.query ?? params.query, {
    selector: decision.selector ?? params.selector,
  });
}
