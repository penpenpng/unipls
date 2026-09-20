import { describe, expect, it } from "vite-plus/test";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

describe("supported runtime primitives", () => {
  it("uses the native AbortSignal.any contract", () => {
    // Run the shared runtime probe and verify that every native-behavior stage passed.
    expect(verifyAbortSignalAny()).toEqual({ checks: 3 });
  });
});
