# unipls 全体設計

## コンポーネント構成

```
┌────────────────────────────────────────┐
│              Unipls                    │  ← 開発者が直接利用するエントリポイント
│  ・プロビジョニング管理                    │
│  ・メッセージングメソッド (listen, request │
│    cast, subscribe, next)              │
│  ・自動再接続ロジック                      │
│  ・再送/再cast 戦略の解釈                  │
└────────────┬───────────────────────────┘
             │ 利用
┌────────────▼───────────────────────────┐
│           UniplsSocket                 │  ← 基礎的な WebSocket ラッパー
│  ・WebSocket ライフサイクル管理             │
│  ・セッション管理 (UniplsSessionState)     │
│  ・シリアライズ/デシリアライズ               │
│  ・drop vs. normal close の判別           │
│  ・enqueue() による送信キュー               │
└────────────┬───────────────────────────┘
             │ 利用
┌────────────▼───────────────────────────┐
│         EventBus / EventBusView        │  ← 型安全なイベントエミッター
└────────────────────────────────────────┘

その他の内部クラス:
・AsyncResult    — 単一の非同期結果 (request 等の戻り値)
・AsyncResults   — 複数の非同期結果ストリーム (listen 等の内部状態)
・AwaitableQueue — 非同期デキュー付きキュー (テストユーティリティ)
```

---

## 各コンポーネントの詳細

### `Unipls` クラス (`src/unipls.ts`)

開発者が直接操作するパブリック API です。`UniplsSocket` を内包し、その上に高レベルロジックを構築しています。

#### 責務

- `#runProvisioner()`: プロビジョナーを実行し `AsyncResult<void>` でラップする
- `#handleDropped()`: drop イベントをフックして自動再接続を起動する
- `#request()`: `request()` / `requestForce()` の共通実装。`AsyncResult` + `EventBusView` で受信を管理する
- `getRetrySetupFunction()` (static): `UniplsRetryStrategy` 文字列を `UniplsRetrySetupFunction` に正規化するファクトリ
- `#processMessage()` (static): セレクタ評価 → コールバック呼び出しの安全なラッパー

#### 自動再接続フロー

```
dropped イベント発火
  → intent === 'open' かつ 同一セッション かつ 再接続中でない
  → #socket.open() を再呼び出し（プロビジョナーを再実行）
  → 成功時に 'reconnect' イベントを emit
```

再接続中は `#reconnectPromise` に Promise を保持し、多重起動を防ぎます。

---

### `UniplsSocket` クラス (`src/unipls-socket.ts`)

WebSocket の低レベルラッパーです。プロビジョニング、シリアライズ、イベントエミッターを備えます。

#### セッション管理

各 `open()` 呼び出しで `UniplsSessionState` が作成され、インクリメントされる整数 `sessionId` が割り当てられます。セッション状態はイベントハンドラで参照され、旧セッションのイベントを無視するために使われます。

`UniplsSessionState` の状態遷移:

```
dead (初期)
  ↓ open() 呼び出し
connecting
  ↓ WebSocket の onopen 発火
provisioning
  ↓ provisioner の実行が完了する
open
  ↓ 正常切断 (close code 1000)
closed
```

または:

```
open (または provisioning / connecting)
  ↓ 異常切断 (close code ≠ 1000) またはタイムアウト
dropped
```

#### close code の扱い

| コード | 定数名                | 意味                                   |
| ------ | --------------------- | -------------------------------------- |
| 1000   | `NORMAL_CLOSURE`      | 正常切断 → `'closed'` 状態へ           |
| 3000   | `IRRECOVERABLE_DROP`  | 回復不能な drop（将来利用予定）        |
| 3001   | `ABNORMAL_CLOSURE`    | `drop()` による強制切断（1006 の代替） |
| 3002   | `MARKED_AS_TIMED_OUT` | タイムアウトによる強制切断             |
| その他 | —                     | 異常切断 → `'dropped'` 状態へ          |

#### `enqueue()` メソッド

`state === 'open'`（または `force: true` かつ `state === 'provisioning'`）になるまで送信を遅延します。drop/close が発生した場合は reject します。`Unipls` レベルの `request()` などはこのメソッドを通じて送信します。

---

### `EventBus<TEvents>` クラス (`src/event-bus.ts`)

ジェネリクスで型安全なイベントエミッターです。

```typescript
const bus = new EventBus<{ message: { text: string }; close: void }>();
bus.on('message', ({ text }) => console.log(text));
bus.emit('message', { text: 'hello' });
```

#### `EventBusView`

`spawnEventBusView()` で作成するスコープ付きビューです。ビューを通じて登録したすべてのリスナーを `dispose()` 一発で解除できます。

各メッセージング操作（`request()`, `listen()` など）はそれぞれ独立した `EventBusView` を生成し、操作完了時に `dispose()` することでリスナーのリークを防いでいます。

`Symbol.dispose` を実装しており、`using` 構文にも対応しています。

---

### `AsyncResult<T>` クラス (`src/async-result.ts`)

単一の非同期結果（成功/失敗）を表現するクラスです。

- `promise`: 外部から await できる Promise
- `resolve(value)` / `reject(reason)`: 結果を確定させる（べき等）
- `resulted`: 結果が確定済みかどうか
- `signal`: 外部 `AbortSignal` と内部コントローラーを合成した `AbortSignal`
- `timeout` オプション: 指定時間後に `UniplsTimeoutError` で自動 reject
- `finally` コールバック: 結果確定時（中断含む）に必ず呼ばれるクリーンアップ

内部で `AbortController` を使い、`resolve`/`reject` 後にクリーンアップを自動実行します。

---

### `AsyncResults<T>` クラス (`src/async-results.ts`)

複数の非同期結果（ストリーム）を管理するクラスです。`listen()` の内部実装に使われます。

- `handleMessage(message)`: `onMessage` コールバックを呼び出す
- `handleTerminator(message)`: `onTerminated` を呼び出してストリームを終了させる
- `handleError(error)`: `onError` を呼び出す（致命的でないエラー）
- `raiseFatalError(error)`: `onFatalError` を呼び出してストリームを終了させる
- `unsubscribe()`: `onUnsubscribed` を呼び出してストリームを終了させる

終了理由 (`SubscriptionEndReason`) は終了後に `finally` コールバックへ渡されます。

---

### `UniplsReconnector` インターフェース (`src/unipls-reconnector.ts`)

再接続の可否・タイミングを制御するカスタム戦略インターフェースです（現在 `Unipls` からは利用されていませんが、将来の拡張を見越して定義されています）。

```typescript
interface UniplsReconnector {
  reconnect(ctx: ReconnectionContext): boolean | Promise<boolean>;
}
```

`ReconnectionContext` には以下が含まれます:

- `session`: 現在のセッション ID
- `lastAttemptedAt`: 前回の試行時刻
- `sessionAttempts` / `allAttempts`: 試行履歴

---

### `AwaitableQueue<T>` クラス (`src/libs/awaitable-queue.ts`)

非同期デキューをサポートするキューです。テストコードで活用されています（`mock-server` の受信 inbox など）。

- `enqueue(value, options?)`: 値をキューに積む。値が即デキューされない場合、デキューされるまで Promise をブロックする
- `dequeue(options?)`: キューから値を取り出す。キューが空なら次の `enqueue` まで待機する
- `dequeueSync()`: 同期的に取り出す。空なら `AwaitableQueueEmptyError` を throw する
- `clear()`: キューをクリアする

---

## ファイル構成

```
src/
├── index.ts                  # (現在は placeholder)
├── types.ts                  # 基本型定義 (WebSocketData, SessionId 等)
├── errors.ts                 # エラークラス定義
├── unipls.ts                 # Unipls クラス (メインエントリポイント)
├── unipls.interface.ts       # Unipls の公開 API に関わる型定義
├── unipls-socket.ts          # UniplsSocket クラス
├── unipls-reconnector.ts     # UniplsReconnector インターフェース
├── event-bus.ts              # EventBus / EventBusView クラス
├── async-result.ts           # AsyncResult クラス
├── async-results.ts          # AsyncResults クラス、UniplsSubscriber 型
├── libs/
│   ├── index.ts              # libs の re-export
│   ├── awaitable-queue.ts    # AwaitableQueue クラス
│   └── utils.ts              # u ユーティリティ (Promise.timeout 等)
└── __test__/
    ├── mock-server.ts        # テスト用 WebSocket サーバーモック (msw ベース)
    ├── listen.spec.ts        # listen() のテスト
    ├── request.spec.ts       # request() のテスト
    ├── reconnection.spec.ts  # 自動再接続のテスト
    ├── provisioning.spec.ts  # プロビジョニングのテスト
    └── serialization.spec.ts # シリアライズ/デシリアライズのテスト
```

---

## データフロー

### メッセージ受信フロー (listen の例)

```
WebSocket.onmessage
  → EventBus.emit('raw-message', { session, data })
  → EventBus.emit('message', { session, message: deserialize(data) })
  → EventBusView(listen 用) の 'message' ハンドラ
    → #processMessage(): selector で絞り込み
      → AsyncResults.handleTerminator() または handleMessage()
        → onTerminated() または onMessage() コールバック
```

### メッセージ送信フロー (request の例)

```
unipls.request({ query, selector })
  → AsyncResult<TOutput> を生成
  → EventBusView を生成し 'message' / 'dropped' を購読
  → UniplsSocket.enqueue(query)
    → state === 'open' になるまで待機
    → WebSocket.send(serialize(query))
  → 'message' イベントで selector を評価
    → 一致したら AsyncResult.resolve(message)
  → AsyncResult の promise を返す
```

### 自動再接続フロー

```
WebSocket.onclose (code !== 1000)
  → EventBus.emit('raw-close', { code })
  → EventBus.emit('dropped', { session })
  → Unipls の 'dropped' ハンドラ
    → intent === 'open' かつ 再接続未着手ならば
    → UniplsSocket.open() を再呼び出し
      → provisioner を再実行
      → 成功したら EventBus.emit('reconnect', ...)
```

---

## 設計上の注意点・既知の課題

- `index.ts` はまだ placeholder であり、外部向けエクスポートは未整備です。
- `cast()` / `subscribe()` / `next()` / `subscribeForce()` / `castForce()` は `NotImplementedError` を throw します。
- `UniplsReconnector` インターフェースは定義済みですが、`Unipls` の再接続ロジックにはまだ組み込まれていません（現在は drop 時に無条件で即再接続）。
- `UniplsSessionState` が `events` から外部参照可能な状態になっており、将来的に隠蔽する予定です（`FIXME` コメントあり）。
- プロビジョニング完了前の `request()` の送信タイミングに関するテスト (`provisioning.spec.ts`) が現在スキップされています。
