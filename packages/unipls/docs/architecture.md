# unipls Architecture

## 層構造

`unipls` は大きく 2 層です。

1. `UniplsSocket`
   WebSocket の接続管理、シリアライズ、イベント化、送信待機を担当する低レベル層
2. `Unipls`
   provisioning、再接続、retry 戦略、購読 API を提供する高レベル層

補助クラスとして `EventBus`、`AsyncResult`、`AsyncResults`、`UniplsSessionManager`、`DropDetectorManager` があります。

## `UniplsSocket`

責務:

- `WebSocket` の生成と `url` / `timeout` / serializer / deserializer の適用
- `raw-open` / `raw-message` / `raw-close` を公開イベントへ変換
- close code 1000 を `closed`、それ以外を `dropped` として扱う
- `enqueue()` により、接続状態に応じて送信を待機または失敗させる

重要な設計判断:

- `open()` ごとに内部セッション (`UniplsSessionState`) を新規作成する
- `raw-open` の時点で state を `provisioning` にし、provisioner 完了後に `open` を emit する
- `force: true` の送信は `provisioning` 中でも `raw-open` 後なら許可する

## `Unipls`

責務:

- `open()` 時にセッション管理を開始する
- provisioning を `#runProvisioner()` で統一実行する
- `next` / `listen` / `cast` / `request` / `subscribe` を提供する
- `dropped` を受けて `reconnector` を起動する
- 再接続成功後に `reconnect` イベントを emit する

設計の要点:

- `UniplsSocket` のイベントを元に、各操作は `EventBusView` を作って局所的に購読する
- 単発応答は `AsyncResult`、購読型は `AsyncResults` でライフサイクルを管理する
- `request` / `subscribe` は `retry` 戦略により再接続後の挙動を切り替える

## セッション管理

`UniplsSessionManager` は、`UniplsSocket` が持つ接続セッションとは別に、`open()` 呼び出し単位の論理セッションを管理します。

- `new()`: 新しい論理セッション開始
- `abort()`: `close()` 時にセッション全体の `AbortSignal` を中断
- `recordAttempt()`: 再接続試行を履歴へ追加
- `onSuccess()`: 再接続成功時のイベントを構築
- `onFailure(err)`: 次回再接続コンテキスト用にエラーを保存

この設計により、1 回の `open()` の間に複数回の物理接続が発生しても、再接続文脈をまとめて扱えます。

## EventBus と操作スコープ

各 API 呼び出しは `spawnEventBusView()` で独立ビューを作り、完了時に必ず `dispose()` されます。これにより:

- 個別操作が他の操作の listener を汚染しない
- timeout / abort / success / error のどれでも後片付けができる

## 現時点で見えている設計ギャップ

- `next()` / `listen()` は drop 時に即失敗しており、`reconnector` がある場合の待機継続設計と一致していない
- `#handleDropped()` は `cancel()` と cleanup をまだ処理していない
- provisioning 失敗時のソケット状態遷移と `open()` の reject 伝播が不十分
- `AsyncResults.raiseFatalError()` はコールバック例外をそのまま未処理 rejection にしやすい
