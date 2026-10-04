import { describe, expect, it } from "vite-plus/test";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

describe("サポートする実行環境の標準 API", () => {
  /**
   * ```ts
   * const session = new AbortController();
   * const operation = new AbortController();
   * const signal = AbortSignal.any([session.signal, operation.signal]);
   * session.abort(reason);
   * operation.abort(anotherReason);
   * // signal.reason は reason と同じ参照になり、後発の anotherReason へ変わらない
   * ```
   */
  it("標準の AbortSignal.any 契約を利用する", () => {
    // 共通 probe を実行し、標準 API のすべての検証段階が成功したことを確認します。
    expect(verifyAbortSignalAny()).toEqual({ checks: 3 });
  });
});
