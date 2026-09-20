import { describe, expect, it } from "vite-plus/test";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

describe("AbortSignal.any の実行環境検証", () => {
  it("すべての検証後に不変の結果を返す", () => {
    // 標準 API を対象とする共通検証を実行します。
    const result = verifyAbortSignalAny();

    // probe が全段階を報告し、不変の結果を公開することを確認します。
    expect(result.checks).toBe(3);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
