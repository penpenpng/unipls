# unipls API 仕様

## `Unipls<TInput, TOutput>` クラス

メインエントリポイントとなるクラスです。

- `TInput`: 送信メッセージの型
- `TOutput`: 受信メッセージの型

デフォルトはどちらも `WebSocketData`（= `string | ArrayBufferLike | Blob | ArrayBufferView`）です。

---

### コンストラクタ

```typescript
new Unipls<TInput, TOutput>(params: UniplsParams<TInput, TOutput>)
```

#### `UniplsParams`

| プロパティ | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `url` | `string` | ✓ | — | WebSocket 接続先 URL |
| `serializer` | `(data: TInput) => WebSocketData` | — | 恒等変換 | 送信前に `TInput` を `WebSocketData` へ変換する関数 |
| `deserializer` | `(data: WebSocketData) => TOutput` | — | 恒等変換 | 受信後に `WebSocketData` を `TOutput` へ変換する関数 |
| `WebSocket` | `WebSocketConstructor` | — | `globalThis.WebSocket` | 利用する WebSocket コンストラクタ。ランタイムに標準 WebSocket がない場合に指定する |
| `timeout` | `number` | — | `5000` | 接続タイムアウト（ミリ秒） |

---

### プロパティ

#### `url: string`

接続先 URL を返します。

#### `state: UniplsConnectionState`

現在の接続状態を返します。値は `'connecting'` / `'provisioning'` / `'open'` / `'closed'` / `'dropped'` のいずれかです。

#### `intent: UniplsConnectionIntent`

現在の接続インテントを返します。値は `'open'` / `'close'` のいずれかです。

---

### メソッド

#### `open(provisioner?: UniplsProvisioner): Promise<void>`

WebSocket 接続を確立します。

- `provisioner` を渡した場合、接続成功直後にそれを実行します。
- 返り値の Promise は接続とプロビジョニングが両方完了したときに resolve します。
- すでに接続中または接続を試行中の場合、`UniplsDuplicatedConnectionError` を throw します。


```typescript
await unipls.open(async (ctx) => {
  await ctx.request({ query: 'auth', selector: (msg) => msg === 'ok' });
});
```

---

#### `close(): Promise<void>`

WebSocket 接続を切断します。

- この切断に伴う自動再接続は行われません。
- すでに切断済みの場合は何もしません。
- 返り値の Promise は切断完了時に resolve します。

---

#### `drop(): void`

WebSocket 接続を異常終了コードで強制切断します。`close()` と異なり、`intent === 'open'` であれば自動再接続が発生します。主にテスト用途です。

---

#### `listen(params): () => void`

0-input N-output 通信を行います。メッセージを受信するだけで送信は行いません。

- 返り値は購読を解除する関数（`unsubscribe`）です。
- `state === 'closed'` の場合は `UniplsClosedError` を throw します。

**引数**: `UniplsSubscriber<TOutput> & UniplsListenOptions<TOutput>`

##### `UniplsListenOptions<TOutput>`

| プロパティ | 型 | 説明 |
|---|---|---|
| `selector` | `(data: TOutput) => boolean` | 購読対象のメッセージを選別する述語関数。省略時はすべてのメッセージが対象 |
| `terminator` | `(data: TOutput) => boolean` | 購読の終端となるメッセージを識別する述語関数。条件を満たした最初のメッセージで購読が終了する |
| `signal` | `AbortSignal` | 購読を中断するための `AbortSignal` |
| `stopListeningOnDropped` | `boolean` | drop 発生時に購読を終了するかどうか。`false`（デフォルト）の場合、再接続後も購読を継続する |

##### `UniplsSubscriber<TOutput>`

| プロパティ | 型 | 説明 |
|---|---|---|
| `onMessage` | `(data: TOutput) => void` | 購読対象メッセージを受信したときのコールバック |
| `onTerminated` | `(data: TOutput) => void` | `terminator` 条件を満たすメッセージを受信したときのコールバック |
| `onError` | `(error: unknown) => void` | セレクタまたはデシリアライザでエラーが発生したときのコールバック |
| `onUnsubscribed` | `() => void` | `unsubscribe()` が呼ばれたときのコールバック |
| `onFatalError` | `(error: unknown) => void` | 致命的なエラー（`UniplsClosedError` など）が発生したときのコールバック |
| `finally` | `(ctx: SubscriptionFinalizationContext) => void` | 購読が何らかの理由で終了したときに必ず呼ばれるコールバック |

##### `SubscriptionFinalizationContext`

| プロパティ | 型 | 説明 |
|---|---|---|
| `reason` | `SubscriptionEndReason` | 購読終了の理由 |
| `error` | `unknown` | `reason === 'fatal-error'` の場合のみ設定されるエラー |

##### `SubscriptionEndReason`

| 値 | 説明 |
|---|---|
| `'terminated'` | `terminator` 条件を満たすメッセージを受信した |
| `'unsubscribed'` | `unsubscribe()` が呼ばれた |
| `'closed'` | `close()` で切断された |
| `'dropped'` | drop が発生した（`stopListeningOnDropped: true` の場合） |
| `'fatal-error'` | その他の致命的なエラー |

---

#### `request(params): Promise<TOutput>`

1-input 1-output 通信を行います。クエリを送信し、セレクタ条件を最初に満たしたレスポンスを Promise で受け取ります。

- プロビジョニングが完了していない場合、完了まで送信を遅延します。
- `state === 'closed'` の場合は `UniplsClosedError` を throw します。

**引数**: `UniplsRequestParams<TInput, TOutput>`

##### `UniplsRequestParams<TInput, TOutput>`

| プロパティ | 型 | 必須 | 説明 |
|---|---|---|---|
| `query` | `TInput \| (() => TInput)` | ✓ | 送信するクエリ。関数を渡した場合、送信時（再送時を含む）に評価される |
| `selector` | `(data: TOutput) => boolean` | ✓ | レスポンスを識別する述語関数 |
| `timeout` | `number` | — | レスポンス待機のタイムアウト（ミリ秒） |
| `signal` | `AbortSignal` | — | 待機を中断するための `AbortSignal` |
| `retry` | `UniplsRetryStrategy<TInput, TOutput>` | — | drop 発生時の再送戦略。デフォルトは `'never'` |

#### `requestForce(params): Promise<TOutput>`

`request()` と同様ですが、プロビジョニング中でも接続完了後ただちに送信します。プロビジョナー内から呼び出す場合に使用します。

---

#### `cast(data, options?): Promise<void>` *(未実装)*

1-input 0-output 通信を行います。メッセージを送信するだけで受信は行いません。

#### `castForce(data, options?): Promise<void>` *(未実装)*

プロビジョニング中でも送信を試みる `cast()` のバリアントです。

#### `subscribe(params): () => void` *(未実装)*

1-input N-output 通信を行います。クエリを送信し、複数のレスポンスを購読します。

#### `subscribeForce(params): () => void` *(未実装)*

プロビジョニング中でも送信を試みる `subscribe()` のバリアントです。

#### `next(params): Promise<TOutput>` *(未実装)*

0-input 1-output 通信を行います。次に受信する（セレクタ条件を満たす）メッセージを Promise で受け取ります。

---

### イベント

`on(event, listener)` / `off(event, listener)` でリッスンできます。

| イベント名 | ペイロード | 説明 |
|---|---|---|
| `'open'` | `{ session: UniplsSessionState }` | プロビジョニング完了後に発火 |
| `'message'` | `{ session: UniplsSessionState; message: TOutput }` | メッセージ受信時に発火 |
| `'closed'` | `{ session: UniplsSessionState }` | 正常切断時に発火 |
| `'dropped'` | `{ session: UniplsSessionState }` | 予期しない切断時に発火 |
| `'reconnect'` | `{ previousSessionId: SessionId; sessionId: SessionId }` | 自動再接続成功時に発火 |

---

## 再送戦略

### `UniplsRetryStrategy<TInput, TOutput>`

`request()` / `subscribe()` の `retry` オプションに指定します。

| 値 | 説明 |
|---|---|
| `'never'` | 再送しません。drop 時に `UniplsDroppedError` で reject します |
| `'re-request'` | 再接続後に同じクエリを再送します |
| `'keep-listening'` | 再接続後にクエリは再送しませんが、レスポンスの待機を継続します |
| `UniplsRetrySetupFunction` | カスタムの再送ロジックを関数で定義します |

#### `UniplsRetrySetupFunction<TInput, TOutput>`

```typescript
type UniplsRetrySetupFunction<TInput, TOutput> = (ctx: UniplsRetrySetupContext<TInput, TOutput>) => void;
```

#### `UniplsRetrySetupContext<TInput, TOutput>`

| プロパティ | 型 | 説明 |
|---|---|---|
| `onReconnected` | `(callback: (ctx: UniplsRetryContext) => void) => void` | 再接続後に呼ばれるコールバックを登録する |
| `data` | `UniplsMessageFactory<TInput>` | 直前に送信を試みたクエリ |
| `selector` | `(data: TOutput) => boolean` | 直前に指定したセレクタ |
| `abort` | `(error?: unknown) => void` | 再送処理を中断する |

#### `UniplsRetryContext<TInput, TOutput>`

`onReconnected` のコールバック引数です。

| プロパティ | 型 | 説明 |
|---|---|---|
| `request` | `(data, { selector }) => void` | 再送を試みる |
| `done` | `() => void` | 再送処理が完了したことを通知する |
| `reconnection` | `{ previousSessionId, sessionId }` | 再接続情報 |

---

### `UniplsRecastStrategy<TInput>` *(cast 未実装のため参考)*

`cast()` の `recast` オプションに指定します。

| 値 | 説明 |
|---|---|
| `'never'` | 再送しません |
| `'always'` | 同内容を再送します |
| `UniplsRecastFunction` | カスタムの再送ロジックを関数で定義します |

---

## プロビジョニング

### `UniplsProvisioner<TInput, TOutput>`

```typescript
type UniplsProvisioner<TInput, TOutput> = (ctx: UniplsProvisioningContext<TInput, TOutput>) => void;
```

### `UniplsProvisioningContext<TInput, TOutput>`

| メンバー | 型 | 説明 |
|---|---|---|
| `cast(data)` | `(data: TInput) => Promise<void>` | `castForce()` と同様。`signal` / `recast` は指定不可 |
| `request(params)` | `(params) => Promise<TOutput>` | `requestForce()` と同様。`signal` / `retry` は指定不可 |
| `listen(params)` | `(params) => void` | `listen()` と同様。`signal` / `retry` は指定不可 |
| `subscribe(params)` | `(params) => () => void` | `subscribeForce()` と同様。`signal` / `retry` は指定不可 |
| `session` | `SessionId` | 現在のセッション ID |
| `isSessionBeginning` | `boolean` | このセッション内で初めてのプロビジョニングなら `true`。再接続時のみ `false` になりえる |

---

## エラー型

すべてのエラーは `UniplsError`（`Error` のサブクラス）を継承します。

| クラス | 発生条件 |
|---|---|
| `UniplsClosedError` | 正常切断により操作が中断された |
| `UniplsDroppedError` | 予期しない切断により操作が中断された |
| `UniplsTimeoutError` | タイムアウトが発生した |
| `UniplsDuplicatedConnectionError` | 既に接続中または接続試行中に `open()` が呼ばれた |

---

## 型エイリアス

| 型名 | 定義 | 説明 |
|---|---|---|
| `WebSocketData` | `string \| ArrayBufferLike \| Blob \| ArrayBufferView` | WebSocket で送受信可能なデータ型 |
| `SessionId` | `number` | セッションの一意な識別子 |
| `UniplsConnectionState` | `'connecting' \| 'provisioning' \| 'open' \| 'closed' \| 'dropped'` | 接続状態 |
| `UniplsConnectionIntent` | `'open' \| 'close'` | 接続インテント |
| `UniplsMessageFactory<TInput>` | `TInput \| (() => TInput)` | メッセージを値または評価関数として受け取るユニオン型 |
