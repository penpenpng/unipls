# 5つの通信操作

`unipls`は、送信の有無と受信件数の組み合わせを5つの操作として公開します。

| 操作        | 送信 | 結果 | 主な用途                                |
| ----------- | ---: | ---: | --------------------------------------- |
| `cast`      |    1 |    0 | 通知やcommandを送る                     |
| `next`      |    0 |    1 | 条件に合う次のmessageを待つ             |
| `request`   |    1 |    1 | queryを送り、対応するresponseを待つ     |
| `listen`    |    0 |    N | 条件に合うmessageを継続的に観測する     |
| `subscribe` |    1 |    N | 購読queryを送り、通知を継続的に観測する |

すべての操作はactiveな論理sessionに所属します。`open()`の呼び出し後ならready前でも登録でき、通常の送受信はreadyになるまで待機します。

## cast: 送信だけを行う

```ts
await client.cast({
  query: { type: "set-presence", status: "online" },
  timeout: 3_000,
});
```

PromiseはWebSocketへの送信が完了すると解決します。server側の処理完了や応答を保証するものではありません。応答が必要なら`request()`を使います。

送信値にはfactoryも指定できます。factoryは実際に送信するときに評価されるため、ready待機中に期限切れになる値や、再送ごとに更新したいIDを生成できます。

```ts
await client.cast({
  query: () => ({
    type: "heartbeat",
    sentAt: Date.now(),
  }),
});
```

## next: 受信だけを1件待つ

```ts
const notification = await client.next({
  selector: (message) => message.type === "notification",
  timeout: 30_000,
});
```

`next()`は送信を行いません。既にserver側で開始されている通知や、別の処理が送信したmessageを待つ場合に使います。

## request: 送信して1件待つ

```ts
const requestId = crypto.randomUUID();

const response = await client.request({
  query: { type: "get-order", requestId, orderId },
  selector: (message) => message.type === "order" && message.requestId === requestId,
  timeout: 5_000,
});
```

`request()`は送信が完了してからresponseの観測を開始します。送信完了前に届いたmessageを、そのrequestのresponseとして採用しません。

::: warning selectorは相関IDを作りません
`unipls`はrequest IDやtopicの形式を知りません。IDの生成、server側での引き継ぎ、一致条件はアプリケーションのprotocolとして実装してください。
:::

## listen: 受信を継続する

### callbackで受け取る

```ts
const subscription = client.listen({
  selector: (message) => message.type === "notification",
  next: (message) => {
    renderNotification(message);
  },
});

// 観測を終了する
subscription.unsubscribe();
await subscription.closed;
```

callbackは一致するmessageごとに同期的に呼ばれます。callbackがPromiseを返しても、`unipls`はその完了を待たず、message処理を逐次化しません。順番に非同期処理したい場合はAsyncIterableを使います。

### AsyncIterableで受け取る

`next`を省略すると、single-consumerのAsyncIterableを返します。

```ts
const messages = client.listen({
  selector: (message) => message.type === "notification",
  buffer: 32,
});

try {
  for await (const message of messages) {
    await saveNotification(message);
  }
} finally {
  messages.unsubscribe();
  await messages.closed;
}
```

一つのsubscriptionからiteratorを取得できるのは一度だけです。同じstreamを複数consumerへfan-outしたい場合は、アプリケーション側のstreamやstoreへ渡してください。

## subscribe: 送信して継続的に待つ

```ts
const subscription = client.subscribe({
  query: { type: "subscribe-room", roomId },
  selector: (message) => message.type === "room-event" && message.roomId === roomId,
  next: (message) => updateRoom(message),
});
```

`subscribe()`は購読queryの送信完了後からmessageを観測します。`unsubscribe()`はlocalの観測とresourceだけを終了し、remote側へ購読解除messageを自動送信しません。

server側の購読も解除するprotocolなら、明示的に送信します。

```ts
subscription.unsubscribe();
await subscription.closed;

await client.cast({
  query: { type: "unsubscribe-room", roomId },
});
```

## terminatorでstreamを終了する

`listen()`と`subscribe()`には終了messageを判定する`terminator`を指定できます。

```ts
const stream = client.subscribe({
  query: { type: "run-job", jobId },
  selector: (message) => message.type === "job-progress" && message.jobId === jobId,
  terminator: (message) => message.type === "job-completed" && message.jobId === jobId,
});

for await (const progress of stream) {
  showProgress(progress);
}

const result = await stream.closed;
if (result.ok && result.reason === "terminated") {
  console.log("完了message", result.message);
}
```

terminatorに一致したmessageは通常messageとして重複配送されず、`closed`の`terminated`結果に保持されます。

## timeoutとAbortSignal

すべての操作でtimeoutまたは`AbortSignal`を利用できます。

```ts
const controller = new AbortController();

const pending = client.request({
  query,
  selector,
  timeout: 10_000,
  signal: controller.signal,
});

controller.abort(new Error("画面を離れました"));
```

timeoutはoperationを受け付けた時点から進みます。ready待機や再接続待機の時間も含み、送信時にリセットされません。abort時は`signal.reason`がそのまま失敗理由になります。

`timeout`には有限の正数だけを指定できます。不正な値は非同期のtimeoutではなく、呼び出し時の`RangeError`になります。

## drop時の既定動作

接続回復中にoperationをどう扱うかは`retry`で指定します。

| 操作                    | 選択肢                                          | 省略時     |
| ----------------------- | ----------------------------------------------- | ---------- |
| `next` / `listen`       | `"fail"`, `"wait"`                              | `"wait"`   |
| `request` / `subscribe` | `"fail"`, `"wait"`, `"resend"`, custom recovery | `"fail"`   |
| `cast`                  | 指定なし                                        | dropで失敗 |

`wait`は新しい接続で結果待ちを続けますが、queryを再送しません。`resend`は再送するため、server側の処理が重複する可能性があります。詳しくは[dropと回復](./recovery.md)を参照してください。

再接続用の`reconnector`がclientに設定されていない場合、`wait`や`resend`を指定しても接続自体を回復できないため、operationはdropで終了します。

## predicateとcallbackの失敗

`selector`や`terminator`が例外を投げた場合、既定ではそのmessageだけを無視して後続messageを処理します。operationを終了したい場合は`predicateError: "fail"`を指定します。

callbackの同期例外も既定では診断を通知して購読を継続します。終了したい場合は`callbackError: "unsubscribe"`を指定します。

```ts
const subscription = client.listen({
  next: consume,
  predicateError: "fail",
  callbackError: "unsubscribe",
});
```

## AsyncIterableのbuffer

AsyncIterableは、consumerがまだ処理していないmessageを既定で64件保持します。65件目を受信すると`UniplsBufferOverflowError`で終了します。

```ts
client.listen({ buffer: 128 });
client.listen({ buffer: "latest" });
client.listen({ buffer: { capacity: 32, overflow: "drop-oldest" } });
client.listen({ buffer: { capacity: 32, overflow: "drop-newest" } });
```

- 数値は指定件数を保持し、超過時にerrorにします。
- `"latest"`は最新1件だけを残します。
- lossy policyでmessageを破棄すると`diagnostic` eventが発生します。
- このbufferはclient内部の速度差を吸収するだけで、peerへのbackpressureは提供しません。

## streamの終了結果

`closed`はcleanup完了後に一度だけ解決し、失敗時にもrejectしません。まず`ok`、次に`reason`で絞り込めます。

```ts
const finalization = await subscription.closed;

if (finalization.ok) {
  // terminated / unsubscribed / closed
} else {
  // aborted / timeout / open-error / dropped / buffer-overflow / callback-error / fatal-error
  report(finalization.reason, finalization.error);
}
```

AsyncIteratorの`next()`は異常終了時に同じerrorをthrowします。終了理由を常に値として扱いたい場合は、`closed`を使用してください。
