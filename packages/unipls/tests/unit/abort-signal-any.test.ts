import { describe, expect, it } from "vite-plus/test";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

describe("AbortSignal.any runtime verifier", () => {
  it("returns a frozen result after all checks pass", () => {
    const result = verifyAbortSignalAny();

    expect(result.checks).toBe(3);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
