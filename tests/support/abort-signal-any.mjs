export function verifyAbortSignalAny() {
  let checks = 0;

  // 事前に abort 済みの signal を2つ合成し、入力順の優先規則を確認します。
  const firstPreAbortedReason = { source: "first-pre-aborted" };
  const secondPreAbortedReason = { source: "second-pre-aborted" };
  const firstPreAborted = AbortSignal.abort(firstPreAbortedReason);
  const secondPreAborted = AbortSignal.abort(secondPreAbortedReason);
  const preAbortedResult = AbortSignal.any([firstPreAborted, secondPreAborted]);

  if (preAbortedResult.reason !== firstPreAbortedReason) {
    throw new Error("AbortSignal.any did not preserve input priority");
  }

  checks += 1;

  // active な入力の一方を abort し、reason の同一性を確認します。
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

  // もう一方も abort し、確定済みの結果が変化しないことを確認します。
  secondController.abort(laterReason);

  if (liveResult.reason !== firstLiveReason) {
    throw new Error("AbortSignal.any changed after a later abort");
  }

  checks += 1;

  // unit、host runtime、browser runtime の各テストで共有する不変の結果を返します。
  return Object.freeze({ checks });
}
