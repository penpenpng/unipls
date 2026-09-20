import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

// Execute the shared probe in the current host runtime.
const result = verifyAbortSignalAny();

// Fail the process unless every probe stage completed.
if (result.checks !== 3) {
  throw new Error(
    `Expected 3 AbortSignal.any checks, received ${result.checks}`,
  );
}

// Publish a concise success record for the runtime matrix log.
console.log(`AbortSignal.any: ${result.checks} checks passed`);
