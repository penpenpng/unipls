# Operation Abstractions

## 背景

`Unipls` の 5 つの通信 API

- `next`
- `cast`
- `listen`
- `request`
- `subscribe`

は、入出力の形こそ異なるものの、内部実装にはかなり強い共通構造があります。

現状の [unipls.ts](/home/penpenpng/ghq/github.com/penpenpng/unipls/src/unipls.ts) では、それぞれのメソッドが次の責務を個別に持っています。

- 開始前の `closed` / `signal` 判定
- `EventBusView` の生成と破棄
- `AsyncResult` / `AsyncResults` の生成
- `message` / `error` / `closed` / `dropped` のイベント配線
- query の評価と送信
- 送信前メッセージの無視
- timeout, abort, unsubscribe, terminator の処理
- drop 後の再接続継続戦略の解釈

この構造は、仕様追加のたびに複数 API へ同じ変更を横展開する必要があることを意味します。

## 観測できる共通骨格

5 API は次の 6 フェーズに分解できます。

### 1. 開始条件の検証

- `state === 'closed'` なら失敗
- `signal.aborted` なら失敗

### 2. 操作スコープの生成

- `EventBusView` を生成する
- 単発系なら `AsyncResult`
- 購読系なら `AsyncResults`

### 3. 送信フェーズ

query を持つ API では:

- `query` の評価
- `enqueue()` による送信
- provisioning 中の待機
- 送信完了前メッセージの無視

### 4. 受信フェーズ

- `message` を selector / terminator で振り分ける
- deserialize failure は `error` イベントとして扱う

### 5. 終了フェーズ

- `closed`
- `dropped`
- `timeout`
- `abort`
- `unsubscribe`
- `terminated`

を単発解決または購読終了へ変換する。

### 6. 再接続フェーズ

- `request` / `subscribe` は `fail | wait | resend | { recover(...) }`
- `next` / `listen` は `fail | wait`

という drop 戦略を解釈する。

## 提案するモジュール分解

巨大な generic 関数 1 個に統合するのではなく、役割の異なる 3 モジュールへ分ける。

### 1. Operation Scope

候補ファイル:

- `src/operations/operation-scope.ts`

責務:

- `EventBusView` と結果オブジェクトの生成
- `closed`, `dropped`, `error`, `abort`, `timeout` の共通配線
- 後始末の集中管理

このモジュールが隠蔽するもの:

- `spawnEventBusView()`
- `AsyncResult` と `AsyncResults` の違い
- `finally` と cleanup の組み合わせ

概念モデル:

```ts
type OperationMode = 'single' | 'stream';

interface OperationScope<T> {
  mode: OperationMode;
  resulted: boolean;
  signal: AbortSignal;
  resolve(value: T): void;
  reject(error: unknown): void;
  push?(value: T): void;
  terminate?(value: T): void;
  handleError(error: unknown): void;
  handleFatal(error: unknown): void;
  dispose(): void;
}
```

効果:

- `next` と `request` の違いは「query があるかどうか」だけに近づく
- `listen` と `subscribe` の違いも同様
- timeout や cleanup の修正漏れを減らせる

### 2. Query Session

候補ファイル:

- `src/operations/query-session.ts`

責務:

- `query` の現在値を保持する
- 送信時にだけ `query` を評価する
- `requestSent` を管理して送信前メッセージを無視する
- 再接続時に送信状態をリセットする
- `resend` 時の query 再評価を担う

現状では次の重複を吸収できる:

- `#request` 内の `activeRequest`, `activeSelector`, `requestSent`, `request()`
- `#subscribe` 内の同内容

概念モデル:

```ts
interface QuerySession<TIn, TOut> {
  sent: boolean;
  currentQuery: UniplsMessageFactory<TIn>;
  currentSelector: (msg: TOut) => boolean;
  send(
    query: UniplsMessageFactory<TIn>,
    selector: (msg: TOut) => boolean,
  ): Promise<void>;
  resetForReconnect(): void;
  acceptsMessage(): boolean;
}
```

効果:

- `request` と `subscribe` の仕様差分が見えやすくなる
- 送信前メッセージ無視や再送時再評価のバグを局所化できる

### 3. Drop Policy

候補ファイル:

- `src/operations/drop-policy.ts`

責務:

- drop 時の再接続継続戦略を解釈する
- `request` / `subscribe` と `next` / `listen` の戦略差を同じ抽象で表現する

扱う戦略:

- `fail`
- `wait`
- `resend`
- custom `recover()` strategy

概念モデル:

```ts
interface DropPolicyContext<TIn, TOut> {
  reconnectable: boolean;
  onFatal(error: unknown): void;
  onKeepListening(): void;
  recover?(ctx: { request?: QuerySession<TIn, TOut> }): void | Promise<void>;
  requestSession?: QuerySession<TIn, TOut>;
}

interface DropPolicy<TIn, TOut> {
  onDropped(ctx: DropPolicyContext<TIn, TOut>): void;
}
```

効果:

- `next/listen/request/subscribe` の drop 分岐を 1 箇所へ寄せられる
- 新しい drop 戦略を足しやすい
- `reconnector` の有無と retry オプションの相互作用が明確になる

## 各 API の再構成イメージ

### `next`

- `OperationScope(single)`
- query なし
- `DropPolicy(fail | wait)`

### `listen`

- `OperationScope(stream)`
- query なし
- `DropPolicy(fail | wait)`

### `request`

- `OperationScope(single)`
- `QuerySession`
- `DropPolicy(fail | resend | wait | recover)`

### `subscribe`

- `OperationScope(stream)`
- `QuerySession`
- `DropPolicy(fail | resend | wait | recover)`

### `cast`

- `OperationScope(single-like)`
- `QuerySession` の簡略版、または send-only セッション
- drop policy は現状なし

## 推奨リファクタ順

安全に進めるなら次の順がよい。

### Step 1

`#request` と `#subscribe` から `QuerySession` を抽出する。

理由:

- 最も重複が多い
- 振る舞いが近い
- テストがすでに厚い

### Step 2

`next/listen/request/subscribe` の `EventBusView` と結果オブジェクト生成を `OperationScope` に寄せる。

理由:

- cleanup と timeout の扱いを一元化できる
- deserialize error の配線をまとめられる

### Step 3

retry / drop ハンドリングを `DropPolicy` に移す。

理由:

- 仕様変更の集中点になる
- `next/listen` と `request/subscribe` の差を最小化できる

### Step 4

最後に `cast` を同じ枠組みに寄せる。

理由:

- 最も特殊で、send-only の違いがある
- 先に他 4 API で抽象が安定してから寄せた方が安全

## 避けたい設計

### 1. 巨大な万能 generic 関数

5 API をすべて 1 関数へ押し込むと、型はまとまっても可読性が落ちる。

### 2. `AsyncResult` と `AsyncResults` を無理に統一する

単発と購読は終了モデルが違う。薄い共通インターフェースを被せるのはよいが、完全統一は逆に見通しを悪くする。

### 3. retry 戦略と query 送信を同じ層で抱える

再接続ポリシーの責務と、送信状態管理の責務は分けた方が保守しやすい。

## 期待効果

- `request` と `subscribe` の仕様修正を 1 箇所へ集約できる
- `next` と `listen` の drop 戦略追加が容易になる
- timeout, deserialize error, cleanup のような横断仕様の修正漏れを減らせる
- `Unipls` 本体の可読性が上がり、各 API が「何を構成しているか」で読めるようになる
