# unipls 概要

## 目的

unipls は JavaScript ランタイムのための高レベル WebSocket クライアントライブラリです。

多くのランタイムが提供するビルトインの `WebSocket` クラスはソケットレベルの API（接続・送信・受信・切断）を提供するにとどまります。一方 unipls は、それらの上位に位置する以下の機能を提供することを目指しています。

- **メッセージのシリアライズ/デシリアライズ**: 任意の型への変換ロジックをコンストラクタで一元定義できます。
- **リクエスト/レスポンスのペアリング**: `request()` を用いることで、送信したクエリに対するレスポンスを Promise として受け取れます。
- **複数レスポンスの購読**: `subscribe()` / `listen()` を用いることで、条件を満たす複数のメッセージをストリームとして扱えます。
- **接続プロビジョニング**: `open()` にプロビジョニング関数を渡すことで、接続確立直後に行うべき初期化処理（認証メッセージの送信など）を宣言的に記述できます。
- **自動再接続**: 予期しない切断（drop）が発生した場合に自動的に再接続を試み、プロビジョニングを再実行します。
- **再送戦略**: 再接続後にリクエストを再送するかどうかを `retry` / `recast` オプションで制御できます。

## コアコンセプト

### セッション

`open()` が呼ばれてから `close()` が呼ばれるまでの期間を **セッション** と呼びます。各セッションには一意な `SessionId`（正の整数）が割り当てられます。drop による自動再接続ではセッション ID が変わりません。

### 接続状態 (`UniplsConnectionState`)

| 状態 | 説明 |
|---|---|
| `'connecting'` | WebSocket が接続を試みている |
| `'provisioning'` | WebSocket 接続済み。プロビジョニング関数の実行中 |
| `'open'` | プロビジョニング完了。メッセージングメソッドが利用可能 |
| `'closed'` | 明示的に `close()` されて切断された |
| `'dropped'` | 予期しない切断が発生した |

### 接続インテント (`UniplsConnectionIntent`)

`intent` は「接続したいか・切断したいか」という意図を表します。

| 値 | 説明 |
|---|---|
| `'open'` | 接続を維持したい（`open()` を呼んだ後） |
| `'close'` | 切断したい（`close()` を呼んだ後） |

`intent === 'open'` かつ drop が発生した場合に自動再接続が行われます。

### プロビジョニング

`open()` の引数に渡す関数を **プロビジョナー** と呼びます。プロビジョナーは WebSocket 接続の確立直後（初回接続・再接続の両方）に実行されます。

プロビジョナーは `ctx.done()` を呼ぶことで初期化完了を通知しなければなりません。`done()` が呼ばれるまで、通常のメッセージングメソッド（`cast` / `request` / `subscribe`）はキューに保持され、完了後に順次送信されます。

### メッセージングメソッド

入出力の数に応じた 4 種類のメソッドがあります（一部は未実装）。

| メソッド | 通信種別 | 実装状況 |
|---|---|---|
| `cast()` | 1-0（送信のみ） | 未実装 |
| `listen()` | 0-N（受信のみ） | 実装済み |
| `request()` | 1-1（リクエスト/レスポンス） | 実装済み |
| `subscribe()` | 1-N（クエリ送信 + 複数レスポンス受信） | 未実装 |
| `next()` | 0-1（次の1件受信） | 未実装 |

### Force バリアント

`cast` / `request` / `subscribe` には `Force` サフィックスを持つバリアントがあります（例: `requestForce()`）。通常バリアントはプロビジョニング完了後まで送信を遅延させますが、Force バリアントはプロビジョニング中でも接続さえ完了していればただちに送信を試みます。プロビジョナー内から呼び出す場合はこのバリアントを使います。

## 基本的な使い方

```typescript
import { Unipls } from 'unipls';

// ジェネリクスパラメータ: <送信型, 受信型>
const unipls = new Unipls<string, string>({ url: 'wss://example.com/socket' });

// プロビジョニング付きで接続
await unipls.open((ctx) => {
  ctx.cast('<auth-token>');
  ctx.done();
});

// 1-1 通信: リクエスト送信 → レスポンス受信
const response = await unipls.request({
  query: 'ping',
  selector: (msg) => msg === 'pong',
});

// 0-N 通信: メッセージ購読
const unsubscribe = unipls.listen({
  selector: (msg) => msg.startsWith('event:'),
  onMessage: (msg) => console.log(msg),
  onFatalError: (err) => console.error(err),
});

// 購読解除
unsubscribe();

// 切断
await unipls.close();
```
