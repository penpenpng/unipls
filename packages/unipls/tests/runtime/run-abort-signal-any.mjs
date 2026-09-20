import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

const result = verifyAbortSignalAny();

if (result.checks !== 3) {
  throw new Error(`Expected 3 AbortSignal.any checks, received ${result.checks}`);
}

console.log(`AbortSignal.any: ${result.checks} checks passed`);
