import { chromium, firefox, webkit } from "playwright";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

const browserTypes = { chromium, firefox, webkit };
const browserName = process.argv[2];
const browserType = browserTypes[browserName];

// Validate the requested browser target before allocating resources.
if (!browserType) {
  throw new Error(`Unknown browser: ${browserName}`);
}

// Launch an isolated headless browser for the native API probe.
const browser = await browserType.launch({ headless: true });

try {
  // Serialize the shared verifier and execute it inside the page realm.
  const page = await browser.newPage();
  const verifierSource = verifyAbortSignalAny.toString();
  const result = await page.evaluate((source) => {
    const verify = globalThis.eval(`(${source})`);
    return verify();
  }, verifierSource);

  // Verify all browser-realm checks completed and report success.
  if (result.checks !== 3) {
    throw new Error(
      `Expected 3 AbortSignal.any checks, received ${result.checks}`,
    );
  }

  console.log(`${browserName} AbortSignal.any: ${result.checks} checks passed`);
} finally {
  // Release the browser even when evaluation or assertions fail.
  await browser.close();
}
