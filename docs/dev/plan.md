# コアコンセプト達成のための実装計画

## 現在の状態

初期releaseで必要なP0/P1の実装は完了しています。実装前に確認された問題、採用した公開判断、依存順、個別checklistは[実装タスクとdecision record](./tasks.md)に、利用者へ保証する概念は[コアコンセプト](../v1/ja/concepts.md)に記録しています。

この文書は未実装項目の一覧ではなく、release candidateの到達点と今後の優先順位を示します。過去の実装形を現行仕様の根拠にはしません。

## 初期releaseで完了した項目

### P0: 公開package

- `unipls`、`unipls/socket`、`unipls/browser`のruntime/types exportsを分離した。
- 高レベルAPIに必要な型とextension契約をrootから公開し、低レベルsocket固有契約をsubpathへ限定した。
- Node.js、Deno、Bun、browser、ES2022のsupport policyを明記した。
- tarballを隔離consumerへinstallし、型検査、import、接続、close/drop cleanup、deep import拒否を検証するsmoke testを追加した。

### P0: lifecycleと回復

- logical session、transport epoch、attempt cycle、recovery cycleを分離し、単一coordinatorだけが公開lifecycleを遷移させる。
- staleなtransport event、provisioning完了、detector callback、reconnect actionを現在のsessionから隔離する。
- user closeとdropをintentで分類し、peer close、transport error、timeout、detector、manual dropを一つのimmutableな`UniplsDrop`へ正規化する。
- 初回接続とready後の回復に同じattempt modelを使い、cancel、exhaustion、reconnector failureを必ずterminal outcomeへ収束させる。

### P1: operationとstream

- `cast`、`next`、`request`、`listen`、`subscribe`を共通operation lifecycleへ登録し、受付、timeout、abort、drop、cleanupを一つのsettle gateへ集約した。
- readiness barrierを送受信へ適用し、setup中の通信をtransport epochに束縛されたconnection contextだけへ限定した。
- callback subscriptionとsingle-consumer `AsyncIterable`を共通stream lifecycleのadapterとして実装した。
- retryの`fail`、`wait`、`resend`、custom recoveryを、初回送信前と送信試行後で区別した。
- 必須値や入力型の不正をsession確認より先に同期的な`TypeError`または`RangeError`として拒否する。

### P1: resource、diagnostic、公開契約

- session、connection、setup transaction、detector、operationのresourceを所有scopeへ割り当て、非同期disposerをLIFO順に一度ずつ試行する。
- cleanup failure、message変換、predicate、callback、detector、reconnectorの失敗を有限なdiagnostic unionへ隔離した。
- lifecycle、attempt、drop、event、diagnostic、stream finalizationをruntimeでも不変なsnapshotとして公開する。
- 公開APIの説明を実装詳細ではなく利用者との契約としてJSDocへ記載した。

## release gate

local release確認では次を実行します。

```sh
mise exec -- pnpm format:check
mise exec -- pnpm lint
mise exec -- pnpm typecheck
mise exec -- pnpm test
mise exec -- pnpm build
mise exec -- pnpm test:package
git diff --check
```

CIは同じtarballをNode.js、Deno、Bunの最低版と最新stable、および最新2系統のPlaywrightに対応するChromium、Firefox、WebKitで検証します。詳細な契約とtestの対応は[release監査記録](./release-audit.md)に記録します。

## 次期milestoneへ移す項目

次の項目は初期releaseのblockerではなく、実利用または測定結果が得られた場合に追加APIとして検討します。

- 特定message schema、RPC envelope、exactly-once、永続queue、server replayなどのprotocol layer。これらはcoreの対象外を維持する。
- runtime matrixのversion更新と長期負荷測定。公開契約を変えず継続的なrelease maintenanceとして扱う。

初期releaseに未決のP0/P1設計判断は残していません。新しい公開判断が必要になった場合は、実装より先に`tasks.md`のdecision recordとcontract testを更新します。
