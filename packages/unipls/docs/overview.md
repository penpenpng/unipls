# unipls Overview

## このライブラリが解決したい課題

`unipls` は素の `WebSocket` が持たない、アプリケーション層の通信制御をまとめて扱うためのクライアントライブラリです。現状の実装とテストから読み取れる主目的は次のとおりです。

- 送受信データの型変換を接続単位で一元化する
- メッセージを `cast` / `next` / `request` / `listen` / `subscribe` という通信パターンに分けて扱う
- 接続直後の初期化処理を provisioning として明示化する
- 想定外切断 (`drop`) を検知し、再接続と再購読を制御可能にする
- ブラウザ標準 `WebSocket` に依存しつつ、テストしやすい差し替え可能な API にする

`docs` や JSDoc には未実装と書かれている箇所がありますが、現状のコードベースでは `next` / `cast` / `subscribe` も実装済みです。仕様判断はテストを優先します。

## 現在の主要概念

### セッション

- 1 回の `open()` 呼び出しから、その後の `close()` までが 1 セッション
- `drop` 後の自動再接続でもセッション ID は維持される
- 再接続の試行履歴はセッション単位と全セッション単位の両方で保持する

### 接続状態

- `connecting`: WebSocket 接続中
- `provisioning`: ソケットは開いたが provisioning 未完了
- `open`: provisioning 済みで通常通信可能
- `closed`: 明示的 close 済み
- `dropped`: 異常切断またはタイムアウトで切断された

### provisioning

- `open(provisioner)` の引数として与える
- 初回接続と再接続の両方で実行される
- 通常の `cast` / `request` / `subscribe` は provisioning 完了まで送信を待機する
- provisioning 内では `castForce` / `requestForce` / `subscribeForce` 相当の API が `ctx` から使える

### 想定する切断

- `close()`: 利用者の明示的終了。再接続しない
- `drop()`: 異常終了として扱う。`reconnector` があれば再接続対象
- drop detector: 接続上の異常を外部から検知して `drop()` させる仕組み

## 通信 API の整理

- `cast`: 1-input 0-output
- `next`: 0-input 1-output
- `request`: 1-input 1-output
- `listen`: 0-input N-output
- `subscribe`: 1-input N-output

`request` と `subscribe` は `retry` 戦略を持ち、再接続後に待機継続だけ行うか、同じ query を再送するかを選べます。`listen` と `next` は query を持たないため、再接続後は待機継続が基本方針としてテストで要求されています。

## 2026-04-06 時点の既知の不整合

テストから見ると未完了の実装が残っています。

- `next()` が `reconnector` 存在時でも drop 直後に失敗してしまう
- `listen()` / `subscribe()` の再接続継続が壊れている
- provisioning 失敗が `open()` に正しく伝播しない
- 再接続の `cancel()` / cleanup まわりは未実装 TODO が残っている
