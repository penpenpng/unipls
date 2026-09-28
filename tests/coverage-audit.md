# 公開前のテスト確認

公開文書 `docs/v1/ja/concepts.md`、`operations.md`、`recovery.md` と既存の contract test を照合し、機能間の組み合わせを補いました。行・分岐カバレッジ率は計測していません。以下は公開契約とシナリオの確認記録です。

## 既存テストで確認できる範囲

| 領域 | 主なテスト |
| --- | --- |
| 公開 entry、入力検証、型、実行環境の前提 | `public-api`、`socket-public-api`、`runtime`、`api/` |
| 初回接続、provisioning、session と connection の寿命 | `lifecycle`、`open-provisioning`、`provisioning-resource` |
| 切断分類、再試行、回復断念、古い接続の隔離 | `close-drop-classification`、`reconnection-engine`、`transport-epoch-isolation` |
| 5種類の operation、送受信境界、retry、timeout、abort | `cast`、`next`、`request`、`listen`、`subscribe`、`operation-lifecycle` |
| callback / iterator、終了競合、buffer、predicate と callback の失敗 | `stream-operation` |
| 変換、event、error、diagnostic、detector の cleanup | `serialization`、`public-event-error-diagnostic`、`drop-detector-lifecycle` |
| 内部資源、heartbeat、決定的なテスト用通信環境 | `unit/` |
| 配布物、exports、隔離 consumer、公開型 | `package/`、`api/` |

表中の拡張子を省略した名前は `contract/*.spec.ts` を指します。

## 今回補った組み合わせ

`contract/combined-recovery.spec.ts` に15ケースを追加しました。

| ケース数 | シナリオ | 確認する結果 |
| --- | --- | --- |
| 6 | request と subscribe に同じ custom recovery を指定 | `wait`、`undefined`、`resend`、query のみ更新、selector のみ更新、`fail` の意味が一致し、省略値を引き継ぐ |
| 6 | 非同期 recovery の完了前に abort / unsubscribe / close。その後 resolve / reject | 確定済みの終了結果を維持し、query factory を評価せず、送信も再開しない。待機中の iterator も終了する |
| 1 | request・subscribe・listen を動かしたまま2回再接続 | 各 ready で一度だけ再送し、buffer を保持する。provisioning 中と古い接続の message を配送しない |
| 1 | 回復待機中の abort、再接続の provisioning 中の timeout、独立した購読の回復 | 受付時からの deadline を維持し、終了済み query を再送しない。独立した購読は継続し、終了後に timer が残らない |
| 1 | buffer を残して回復し、次の message で overflow。その後もう一度再接続 | overflow を当該購読に隔離する。同じ message は request / listen に届き、終了した購読は次の接続で再送されない |

controlled WebSocket と hook、fake timer により順序を固定し、実時間やネットワークの偶然には依存させていません。新しいケースで production code の修正を要する失敗はありませんでした。

## 実行結果と制約

- contract / unit: 27ファイル、139ケース成功（追加前は26ファイル、124ケース）。
- source / test の TypeScript 検査、build 後の公開 API 型検査: 成功。
- build と `test:package`: 成功。隔離した Node.js consumer の15項目と consumer の型検査を含みます。
- format: 対象82ファイル成功。lint: package の対象ディレクトリで成功。
- Deno、Bun、実ブラウザの matrix は今回実行していません。公開前には該当 CI の結果を別途確認します。

この親 workspace では root の Vite+ 0.3.3 と本 package の0.1.24が混在し、通常の起動で native binding の解決に失敗しました。検証時は `node_modules` 内で0.1.24の解決先を補正しています。依存定義と lockfile は変更していません。

また、`pnpm --filter unipls check` は親 workspace の除外設定を拾い、対象ファイルなしで失敗しました。そのため format は本 package の Oxfmt に `--config vite.config.mjs` を明示し、lint は本 package の Oxlint に空の設定を明示して、`check` と同じ対象ディレクトリを検査しました。本 package の lint 設定は未指定のため既定ルールを使います。通常の `check` コマンドが成功したという記録ではありません。親 workspace でのツール解決・設定探索は、テストの挙動とは別の残課題です。
