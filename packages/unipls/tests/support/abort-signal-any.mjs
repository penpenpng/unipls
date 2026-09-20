export function verifyAbortSignalAny() {
  let checks = 0;

  const firstPreAbortedReason = { source: "first-pre-aborted" };
  const secondPreAbortedReason = { source: "second-pre-aborted" };
  const firstPreAborted = AbortSignal.abort(firstPreAbortedReason);
  const secondPreAborted = AbortSignal.abort(secondPreAbortedReason);
  const preAbortedResult = AbortSignal.any([firstPreAborted, secondPreAborted]);

  if (preAbortedResult.reason !== firstPreAbortedReason) {
    throw new Error("AbortSignal.any did not preserve input priority");
  }
  checks += 1;

  const firstController = new AbortController();
  const secondController = new AbortController();
  const liveResult = AbortSignal.any([firstController.signal, secondController.signal]);
  const firstLiveReason = { source: "first-live" };
  const laterReason = { source: "later" };

  firstController.abort(firstLiveReason);
  if (liveResult.reason !== firstLiveReason) {
    throw new Error("AbortSignal.any did not preserve reason identity");
  }
  checks += 1;

  secondController.abort(laterReason);
  if (liveResult.reason !== firstLiveReason) {
    throw new Error("AbortSignal.any changed after a later abort");
  }
  checks += 1;

  return Object.freeze({ checks });
}
