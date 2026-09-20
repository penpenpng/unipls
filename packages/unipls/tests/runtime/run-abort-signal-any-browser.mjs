import { chromium, firefox, webkit } from "playwright";

import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

const browserTypes = { chromium, firefox, webkit };
const browserName = process.argv[2];
const browserType = browserTypes[browserName];

// resource を確保する前に対象 browser を検証します。
if (!browserType) {
  throw new Error(`Unknown browser: ${browserName}`);
}

// 標準 API の probe 用に分離された headless browser を起動します。
const browser = await browserType.launch({ headless: true });

try {
  // 共通検証関数を serialize し、page realm 内で実行します。
  const page = await browser.newPage();
  const verifierSource = verifyAbortSignalAny.toString();
  const result = await page.evaluate((source) => {
    const verify = globalThis.eval(`(${source})`);
    return verify();
  }, verifierSource);

  // browser realm 内の全検証が完了したことを確認し、成功を出力します。
  if (result.checks !== 3) {
    throw new Error(`Expected 3 AbortSignal.any checks, received ${result.checks}`);
  }

  console.log(`${browserName} AbortSignal.any: ${result.checks} checks passed`);
} finally {
  // 評価または assertion が失敗した場合も browser を終了します。
  await browser.close();
}
