import { verifyAbortSignalAny } from "../support/abort-signal-any.mjs";

// 現在の host runtime で共通 probe を実行します。
const result = verifyAbortSignalAny();

// すべての検証段階が完了していなければ process を失敗させます。
if (result.checks !== 3) {
  throw new Error(`Expected 3 AbortSignal.any checks, received ${result.checks}`);
}

// runtime matrix の log に簡潔な成功結果を出力します。
console.log(`AbortSignal.any: ${result.checks} checks passed`);
