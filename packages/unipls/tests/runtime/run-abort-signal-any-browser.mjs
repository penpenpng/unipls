import { chromium, firefox, webkit } from "playwright";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

const browserTypes = { chromium, firefox, webkit };
const browserName = process.argv[2];
const browserType = browserTypes[browserName];

if (!browserType) {
  throw new Error(`Unknown browser: ${browserName}`);
}

const browser = await browserType.launch({ headless: true });

try {
  const page = await browser.newPage();
  const verifierSource = verifyAbortSignalAny.toString();
  const result = await page.evaluate((source) => {
    const verify = globalThis.eval(`(${source})`);
    return verify();
  }, verifierSource);

  if (result.checks !== 3) {
    throw new Error(`Expected 3 AbortSignal.any checks, received ${result.checks}`);
  }

  console.log(`${browserName} AbortSignal.any: ${result.checks} checks passed`);
} finally {
  await browser.close();
}
