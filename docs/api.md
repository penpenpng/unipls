# unipls API

## `new Unipls(params)`

主要オプション:

- `url`: 接続先 URL
- `serializer`: `TInput -> WebSocketData`
- `deserializer`: `WebSocketData -> TOutput`
- `WebSocket`: テストや非ブラウザ環境向け差し替え口
- `timeout`: 接続確立タイムアウト。既定値は `5000`
- `reconnector`: drop 後に再接続判断を行う戦略
- `dropDetectors`: provisioning 完了後に起動する切断検知プラグイン

## 接続 API

### `open(provisioner?)`

- WebSocket 接続を開始する
- ソケット open 後、provisioner があれば完了まで待つ
- 完了後に state は `open` になる
- 既に接続中または接続試行中なら `UniplsDuplicatedConnectionError`

### `close()`

- 明示切断
- 現在セッションの再接続待機も中断対象
- 既に閉じていれば何もしない

### `drop()`

- 異常切断として扱う強制 close
- `reconnector` があれば再接続フローへ入る

## 通信 API

### `next({ selector, timeout?, signal? })`

- selector に一致する次の 1 件を待つ
- `close()` では `UniplsClosedError`
- `drop` 時の扱いは未整理で、テスト上は `reconnector` なしなら `UniplsDroppedError`、ありなら待機継続が期待値

### `listen(subscriber & { selector?, terminator?, signal? })`

- メッセージ受信専用の継続購読
- `terminator` 一致で終了
- `unsubscribe()` を返す

### `cast({ query, timeout?, signal? })`

- メッセージ 1 件を送信
- provisioning 完了前なら待機

### `castForce(...)`

- provisioning 完了を待たず、接続直後に送信可能

### `request({ query, selector, timeout?, signal?, retry? })`

- query を送り、selector 一致の最初のレスポンスを返す
- `retry` は `never` / `re-request` / `keep-listening` / カスタム関数

### `requestForce(...)`

- provisioning 中でも送信する `request`

### `subscribe(subscriber & { query, selector, terminator?, signal?, retry? })`

- query を送ってから継続購読する
- `retry` の意味は `request` と同じ
- `unsubscribe()` を返す

### `subscribeForce(...)`

- provisioning 中でも送信する `subscribe`

## Provisioning Context

`open(provisioner)` に渡す provisioning は次の context を受け取る:

- `cast(data)`
- `request(params)`
- `listen(params)`
- `subscribe(params)`
- `session`
- `isSessionBeginning`

ここでの `cast` / `request` / `subscribe` は force 系で動作し、初期化中でも送信可能です。

## 購読コールバック

`listen` / `subscribe` の subscriber で使う主なコールバック:

- `onMessage`
- `onTerminated`
- `onError`
- `onUnsubscribed`
- `onFatalError`
- `finally({ reason, error? })`

`reason` は `closed` / `dropped` / `unsubscribed` / `terminated` / `aborted` / `fatal-error` のいずれかです。

## エラー

- `UniplsClosedError`
- `UniplsDroppedError`
- `UniplsTimeoutError`
- `UniplsDuplicatedConnectionError`

## 実装とテストの差分メモ

2026-04-06 時点では、再接続継続と provisioning 失敗伝播に失敗テストがあり、この API 仕様の一部は未完成です。期待値はテストを正として修正を進めます。
