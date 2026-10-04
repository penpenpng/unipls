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
import { Unipls } from "unipls";
import { HeartbeatDropDetector } from "unipls/drop-detectors";

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
import { NetworkDropDetector } from "unipls/drop-detectors";

const client = new Unipls({
  url,
  dropDetectors: [new NetworkDropDetector()],
});
```

`NetworkDropDetector`はbrowser専用です。package rootからはexportされず、Node.js、Deno、Bunでroot moduleをimportしても`window`へアクセスしません。

### browser lifecycle に伴う疎通確認と回復

ブラウザでは、ページの休止などをまたいでWebSocketの疎通が失われることがあります。`BrowserLifecycleDropDetector`はbrowser eventを契機に現在のconnectionでprobeを送り、timeoutした場合にdropを報告します。定期的なheartbeatと併用できます。

```ts
import { Unipls } from "unipls";
import { BrowserLifecycleDropDetector, BrowserLifecycleSource } from "unipls/drop-detectors";
import { BrowserLifecycleReconnector, ExponentialBackoffReconnector } from "unipls/reconnectors";

// sourceはclientごとに作り、detectorとreconnectorで共有します。
const source = new BrowserLifecycleSource();
const client = new Unipls<ClientMessage, ServerMessage>({
  url,
  serializer,
  deserializer,
  dropDetectors: [
    new BrowserLifecycleDropDetector({
      source,
      timeout: 5_000,
      createProbe: () => {
        const id = crypto.randomUUID();
        return {
          query: { type: "ping", id },
          selector: (message) => message.type === "pong" && message.id === id,
        };
      },
    }),
  ],
  reconnector: new BrowserLifecycleReconnector({
    source,
    defaultReconnector: new ExponentialBackoffReconnector({
      initialDelay: 1_000,
      maxDelay: 30_000,
    }),
    maxRetries: 10,
  }),
});
```

対象は`visibilitychange`、`pagehide`、`pageshow`、`freeze`、`resume`、`offline`、`online`です。`freeze`と`pagehide`では進行中のprobeを中断し、復帰後に新しいprobeを送ります。休止前のtimeoutや古いpongを復帰後の判定に使わないため、probeごとに異なるIDで応答を対応付けてください。

hidden中のtimeoutは既定で保留し、visibleに戻ったときに確認し直します。hidden中もtimeoutでdropする場合は`deferWhileHidden: false`を指定します。イベント群は`coalesceDelay`（既定100ms）でまとめます。probeが実行中の復帰イベントでは、古いprobeを中断して確認し直します。

`BrowserLifecycleReconnector`はlifecycle probe起因のdropなら回復cycleの開始時に一度試行します。freeze・pagehide・offlineの状態では待機し、復帰イベントを受けて試行します。一度失敗した後は次の復帰イベントを待ちます。heartbeat、peer close、手動drop、未知のreason、初回接続失敗には`defaultReconnector`へ指定した任意のreconnectorを使い、復帰イベントがあれば待機を短縮します。試行中のイベントは次回の試行として蓄積せず、回復成功後には再接続を予約しません。`maxRetries`は両方の戦略に適用します。

`defaultReconnector`には`ImmediateReconnector`や独自reconnectorも指定できます。元の`ReconnectionContext`をそのまま渡し、`reconnect`・`cancel`・`exhaust`を尊重します。休止や復帰イベントで判断を切り替えるときはdefaultReconnectorのdisposerを実行し、古い判断のactionを無効にします。非同期setupが後から返すdisposerも一度だけ実行します。defaultReconnector自身の再試行上限は、その戦略に委譲された判断に適用されます。

sourceは接続間もsession単位で監視し、session終了時にbrowser listenerを解除します。detector単体でも利用できます。ブラウザへのアクセスは購読時からで、moduleのimportやconstructorではアクセスしません。`freeze`・`resume`を通知しないブラウザでは他のイベントで確認します。イベントが発生しない通信断は、このdetectorだけでは検出できません。

### detector の理由とmetadata

独自detectorは`ctx.drop({ reason, metadata })`で検出の根拠を報告できます。

```ts
ctx.drop({
  reason: "app/protocol-out-of-sync",
  metadata: { expectedSequence: 42, actualSequence: 45 },
});
```

情報は`drop.source.type === "detector"`の場合に`drop.source.reason`と`drop.source.metadata`から参照できます。最初のdrop報告だけが採用され、reconnectorには同じdropが`ctx.drop`として渡ります。再接続試行が失敗しても、回復cycleの起点となるdropを保持します。

`reason`には安定した機械判定用の文字列を使います。組み込みのコードは`DropReasons.BROWSER_LIFECYCLE_PROBE_TIMEOUT`と`DropReasons.HEARTBEAT_RESPONSE_TIMEOUT`です。`isBrowserLifecycleDrop(drop)`も両方の専用entry pointから利用できます。

`metadata`はJSON互換のplain objectで、報告時に各階層をコピーして固定します。循環参照、非有限の数値、`undefined`、関数、Dateなどの値は受け付けず、`TypeError`を投げます。従来の`ctx.drop()`も利用できます。

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
import { Unipls } from "unipls";
import { ImmediateReconnector } from "unipls/reconnectors";

const client = new Unipls({
  url,
  reconnector: new ImmediateReconnector({ maxRetries: 5 }),
});
```

`ImmediateReconnector`は待機せず、接続失敗ごとに次の試行を始めます。`maxRetries`は初回接続を除く再試行回数の上限です。省略時は上限なし、`0`なら初回失敗後に再試行せず終了します。

### 指数 backoff と jitter を使う

```ts
import { ExponentialBackoffReconnector } from "unipls/reconnectors";

const reconnector = new ExponentialBackoffReconnector({
  maxRetries: 5, // 初回接続の後に最大5回再試行
  initialDelay: 500,
  maxDelay: 30_000,
  factor: 2,
});
```

待機時間は上限付きの指数 backoff に full jitter (0から上限までのランダムな時間) を加えて決めます。`maxRetries`を省略すると上限なしで再試行し、`0`なら初回失敗後に再試行せず終了します。session が終了すると待機中の timer は取り消されます。

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
