# dropと回復

通信断からの回復には、性質の異なる3つの判断があります。

1. connectionを失ったと、何を根拠に判断するか
2. 次のconnectionを、いつ試すか
3. 進行中のoperationを、新しいconnectionでどう扱うか

`unipls`はこれらをdrop detector、reconnector、operation retry policyに分けています。

## 1. dropを検出する

WebSocketのpeer close、transport error、接続timeoutは、clientが自動的にdropとして分類します。追加の検出方法は`dropDetectors`で指定します。

### heartbeat

```ts
import { HeartbeatDropDetector, Unipls } from "unipls";

const client = new Unipls<ClientMessage, ServerMessage>({
  url,
  serializer,
  deserializer,
  dropDetectors: [
    new HeartbeatDropDetector({
      interval: 15_000,
      timeout: 5_000,
      ping: () => ({ type: "ping", sentAt: Date.now() }),
      pong: (message) => message.type === "pong",
    }),
  ],
});
```

heartbeatはreadyなconnectionごとに開始されます。指定時間内にpongが届かなければ、そのconnectionをdropとして報告します。

### browserのoffline event

```ts
import { NetworkDropDetector } from "unipls/browser";

const client = new Unipls({
  url,
  dropDetectors: [new NetworkDropDetector()],
});
```

`NetworkDropDetector`はbrowser専用です。package rootからはexportされず、Node.js、Deno、Bunでroot moduleをimportしても`window`へアクセスしません。

### 手動drop

アプリケーション固有の条件で現在のconnectionを失効させる場合は`client.drop()`を呼べます。

```ts
if (protocolIsOutOfSync) {
  client.drop();
}
```

`drop()`は`close()`と異なります。dropは「接続を維持したいが、現在のconnectionは利用できない」という報告であり、reconnectorがあれば回復を始めます。closeはsession自体を終了します。

## canonical drop

同じconnectionにpeer close、heartbeat timeout、transport errorが相次いでも、最初の報告だけを採用します。採用された`UniplsDrop`は、lifecycle、event、operation errorで共有されます。

```ts
client.on("dropped", ({ drop }) => {
  switch (drop.source.type) {
    case "peer-close":
      console.log(drop.close?.code, drop.close?.reason);
      break;
    case "detector":
      console.log(drop.source.detector.name);
      break;
  }
});
```

## 2. reconnectorで次の試行を決める

`reconnector`を省略したclientは、自動再接続を行いません。

### ただちに再接続する

```ts
import { ImmediateReconnector, Unipls } from "unipls";

const client = new Unipls({
  url,
  reconnector: new ImmediateReconnector(),
});
```

`ImmediateReconnector`は待機せず、接続失敗ごとに次の試行を始めます。retry上限やbackoffが必要なproduction用途では、独自reconnectorを実装してください。

### backoffと上限を実装する

```ts
import type { UniplsReconnector } from "unipls";

const reconnector: UniplsReconnector = {
  setup(actions, context) {
    if (context.attempt > 5) {
      actions.exhaust(context.cause);
      return;
    }

    const delay = Math.min(1_000 * 2 ** (context.attempt - 1), 30_000);
    const timer = setTimeout(() => actions.reconnect(), delay);

    const abort = () => clearTimeout(timer);
    context.signal.addEventListener("abort", abort, { once: true });

    return () => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
    };
  },
};
```

`setup()`は直前の失敗ごとに呼ばれます。`context`には次の情報があります。

- `origin`: 初回openの試行か、ready後のrecoveryか
- `stage`: connectingとprovisioningのどちらで失敗したか
- `attempt`: 現在の回復cycle内の試行番号
- `attempts`: 同じsessionで完了したすべての試行履歴
- `cause`: 直前の失敗原因
- `drop`: readyだったconnectionを失った場合の起点
- `signal`: session終了時にabortされるsignal

`actions`では、最初に呼んだ一つだけが有効です。

| action            | 意味                                  |
| ----------------- | ------------------------------------- |
| `reconnect()`     | 新しいWebSocket connectionを1回試す   |
| `cancel()`        | policyの判断で回復を中止する          |
| `exhaust(cause?)` | retryの余地を使い切ったとして終了する |

`setup()`がdisposerを返した場合、そのpolicy判断が確定したときに一度だけ実行します。timerやhost event listenerを必ず片付けてください。

## 3. operationごとに回復方法を選ぶ

connectionがreadyへ戻っても、drop前のqueryがserverへ届いたかはWebSocket clientだけでは確定できません。`request`と`subscribe`は、再送を暗黙に行いません。

### fail

```ts
await client.request({ query, selector, retry: "fail" });
```

drop時に`UniplsDroppedError`で終了します。`request`と`subscribe`の既定値です。

### wait

```ts
await client.request({ query, selector, retry: "wait" });
```

queryを再送せず、新しいconnectionでresponse待ちだけを続けます。serverが処理済みで、再接続後にもresponseを送れるprotocolで利用します。

`next`と`listen`は送信を伴わないため、既定でこの動作です。

### resend

```ts
await client.request({
  query: () => ({
    type: "get-order",
    requestId: crypto.randomUUID(),
    orderId,
  }),
  selector: isOrderResponse,
  retry: "resend",
});
```

新しいconnectionがreadyになったあと、queryを再評価して送信します。drop前の処理と重複しても安全なprotocolだけで使ってください。

::: danger resendはexactly-onceではありません
送信済みかどうかを確定できない状態で再送するため、server処理が二重に実行される可能性があります。冪等なcommand、deduplication key、server側の重複排除などを組み合わせてください。
:::

### custom recovery

queryやselectorを再接続ごとに更新する場合は、`recover()`を指定します。

```ts
const response = await client.request({
  query: initialQuery,
  selector: initialSelector,
  retry: {
    recover({ reconnection }) {
      const requestId = crypto.randomUUID();

      return {
        query: { type: "get-order", requestId, orderId },
        selector: (message) => message.type === "order" && message.requestId === requestId,
      };
    },
  },
});
```

`recover()`は回復成功ごとに呼ばれ、次のいずれかを返せます。

- `"fail"`: operationを終了する
- `"wait"`または`undefined`: 再送せず待機を再開する
- `"resend"`: 現在のqueryとselectorで再送する
- `{ query?, selector? }`: 指定した内容へ更新して再送する

## 回復を観測する

```ts
client.on("reconnect", ({ session, attempts }) => {
  console.log("reconnected", session, attempts.length);
});
```

`reconnect` eventは、replacement connectionのprovisioningまで成功し、通常通信が再開できる時点で通知されます。

回復を最終的に断念した場合、sessionは`closed`へ収束します。activeな`dropped`状態を残したままにはしません。
