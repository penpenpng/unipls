import { describe, expect, it } from "vite-plus/test";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

describe("AbortSignal.any runtime verifier", () => {
  it("returns a frozen result after all checks pass", () => {
    // Execute the shared native-runtime checks.
    const result = verifyAbortSignalAny();

    // Verify the probe reports every stage and exposes an immutable summary.
    expect(result.checks).toBe(3);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
