import { describe, expect, it } from "vite-plus/test";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

describe("supported runtime primitives", () => {
  it("uses the native AbortSignal.any contract", () => {
    expect(verifyAbortSignalAny()).toEqual({ checks: 3 });
  });
});
