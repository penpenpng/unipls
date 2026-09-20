# unipls test layout

- `contract/**/*.spec.ts`: 公開entry pointから観測できるpackage contractを検証する。
- `unit/**/*.test.ts`: 公開契約ではない内部実装、utility、test harnessを検証する。
- `support/`: 現仕様のtestから共有するsupport codeを置く。
- `reference/legacy-implementation/`: 決定前の旧実装に付属していたtestの非規範的な参考資料を置く。

`reference`はtest suiteではない。新しいtestやsourceからimportせず、期待値は必ず`docs/tasks.md`の決定から導出する。
