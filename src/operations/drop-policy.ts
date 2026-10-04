import type {
  UniplsDropRetryStrategy,
  UniplsMessageFactory,
  UniplsRecoveryDecision,
  UniplsRetryStrategy,
} from "../client/unipls.interface.ts";
import type { UniplsReconnectEvent } from "../reconnectors/reconnector.ts";
import { UniplsDroppedError } from "../shared/errors.ts";

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
}): (event: { error: UniplsDroppedError }) => void {
  return ({ error }) => {
    if (params.isDone()) {
      return;
    }

    const retry = params.retry ?? "wait";

    if (!params.reconnectable || retry === "fail") {
      params.onFatal(error);
    }
  };
}

export function createRetryingDropHandler<TInput, TOutput>(params: {
  reconnectable: boolean;
  retry?: UniplsRetryStrategy<TInput, TOutput>;
  isDone: () => boolean;
  onFatal: (error: unknown) => void;
  onReconnected: OnReconnected<TInput, TOutput>;
  pauseForReconnect: () => void;
  resumeWithoutResend: () => void;
  getQuery: () => UniplsMessageFactory<TInput>;
  getSelector: () => (data: TOutput) => boolean;
}): (event: { error: UniplsDroppedError }) => void {
  let waitingForReconnect = false;

  return ({ error }) => {
    if (params.isDone() || waitingForReconnect) {
      return;
    }

    const retry = params.retry ?? "fail";

    if (!params.reconnectable || retry === "fail") {
      params.onFatal(error);

      return;
    }

    waitingForReconnect = true;

    if (retry !== "wait") {
      params.pauseForReconnect();
    }

    const query = params.getQuery();
    const selector = params.getSelector();

    params.onReconnected(async ({ request, reconnection }) => {
      waitingForReconnect = false;

      if (retry === "wait") {
        return;
      }

      if (retry === "resend") {
        await request(query, { selector });

        return;
      }

      const decision = await retry.recover({
        query,
        selector,
        reconnection,
      });

      await runRecoveryDecision(
        decision,
        {
          request,
          query,
          selector,
          resumeWithoutResend: params.resumeWithoutResend,
        },
        error,
      );
    });
  };
}

async function runRecoveryDecision<TInput, TOutput>(
  decision: UniplsRecoveryDecision<TInput, TOutput>,
  params: {
    request: RetryRequest<TInput, TOutput>;
    query: UniplsMessageFactory<TInput>;
    selector: (data: TOutput) => boolean;
    resumeWithoutResend: () => void;
  },
  dropError: UniplsDroppedError,
): Promise<void> {
  if (decision === undefined || decision === "wait") {
    params.resumeWithoutResend();

    return;
  }

  if (decision === "fail") {
    throw dropError;
  }

  if (decision === "resend") {
    await params.request(params.query, {
      selector: params.selector,
    });

    return;
  }

  await params.request(decision.query ?? params.query, {
    selector: decision.selector ?? params.selector,
  });
}
