# 旧実装 test reference

このdirectoryは、設計決定前の旧実装に付属していたtestとsupport codeを、後続作業者が過去のscenario、race、mockの着想を調べるために残した非規範的な参考資料です。元のsource上の位置は`src/__test__`、凍結時点のcommitは`b3c3c0af270f2f29f857158345304515488d486a`です。

## 仕様上の位置付け

- ここにあるassertion、API形状、error、命名、成功・失敗条件は、現在決定した仕様ではありません。
- `*.reference.ts`は`*.spec.ts`でも`*.test.ts`でもなく、test runner、型検査、coverage、test件数の対象外です。
- 現在または将来の実装に対してcompile、実行、成功することを保証しません。importが解決しなくなっても保守対象にしません。
- 仕様の正本は[`docs/overview.md`](../../../docs/overview.md)と[`docs/tasks.md`](../../../docs/tasks.md)です。両者と矛盾する場合は常にdocumentationを優先します。

## 利用方法

scenario、race condition、test doubleの着想を探すためにだけ参照できます。採用する場合は期待値をdocumentationから改めて導出し、公開package contractなら`tests/contract/**/*.spec.ts`、それ以外なら`tests/unit/**/*.test.ts`へ新規に書き直してください。

次の行為は禁止します。

- referenceのassertionを現仕様の根拠として引用する
- referenceを修正または改名して現行test suiteへ戻す
- 新しいsource、test、support codeからreferenceをimportする
- referenceがgreenになることを実装完了条件にする
