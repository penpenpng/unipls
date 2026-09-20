# 接続とreadiness

WebSocketが物理的に開いていることと、アプリケーションが通信を始められることは同じではありません。`unipls`は接続準備をreadinessの境界として扱い、論理sessionと物理connectionを分けて管理します。

## 論理sessionと物理connection

`open()`を呼ぶと、一つの論理sessionが始まります。通信断によってWebSocket connectionが入れ替わっても、回復を続ける間は同じsessionです。

```text
logical session
├── initial connection
├── replacement connection 1
└── replacement connection 2
```

この区別により、次の所有期間を表現できます。

- session全体で一度だけ行う初期化
- connectionが替わるたびにやり直す認証や同期
- drop後も同じsessionに残るoperation
- connection終了時またはsession終了時に解放するresource

## lifecycle snapshot

現在の状態は`client.lifecycle`から、不変なdiscriminated unionとして取得できます。

| `phase`        | 意味                                              |
| -------------- | ------------------------------------------------- |
| `closed`       | 未開始、明示close済み、または回復不能な終了       |
| `connecting`   | 接続開始待ち、またはWebSocket接続試行中           |
| `provisioning` | WebSocketは開いたが、接続準備中                   |
| `open`         | 通常の送受信が可能なready状態                     |
| `recovering`   | readyだったconnectionを失い、次の試行を待っている |

```ts
switch (client.lifecycle.phase) {
  case "open":
    console.log("session", client.lifecycle.session);
    console.log("connection", client.lifecycle.connection);
    break;
  case "recovering":
    console.log("drop source", client.lifecycle.drop.source.type);
    break;
  case "closed":
    console.log("closed reason", client.lifecycle.reason);
    break;
}
```

snapshotと、その中のattempt historyやdrop metadataはruntimeでもfreezeされています。同じ状態の間は同じsnapshot objectを返し、遷移時にだけ新しいobjectへ置き換わります。

## lifecycleの変化を購読する

```ts
const stop = client.on("lifecycle", ({ previous, current }) => {
  console.log(`${previous.phase} -> ${current.phase}`);
});

// 不要になったら解除する
stop();
```

`on()`の戻り値のほか、同じlistenerを`off()`へ渡しても解除できます。一度だけ観測する場合は`{ once: true }`を指定します。

```ts
client.on("open", handleFirstOpen, { once: true });
```

## provisioningでreadyを定義する

`open(provisioner)`へ、sessionごとのsetupとconnectionごとのsetupを渡します。

```ts
await client.open({
  setupSession(ctx) {
    const stop = credentials.onChange(() => invalidateCache());
    ctx.defer(stop, { name: "credentials-listener" });
  },

  async setupConnection(ctx) {
    const response = await ctx.request({
      query: { type: "authenticate", token: credentials.currentToken() },
      selector: (message) => message.type === "authenticated",
      timeout: 5_000,
    });

    if (response.type !== "authenticated") {
      throw new Error("認証に失敗しました");
    }

    connectionStore.set(response);
    ctx.defer(() => connectionStore.clear(), { name: "connection-store" });
  },
});
```

### setupSession

`setupSession`は、同じ論理sessionで一度だけ成功させます。再接続によってconnectionが替わっても繰り返しません。登録したresourceはsession終了時に解放されます。

### setupConnection

`setupConnection`は、初回接続とすべての回復接続で実行します。成功するまでconnectionはreadyになりません。登録したresourceは、そのconnectionを失ったときに解放されます。

contextには準備中のconnectionだけで使える`cast`、`request`、`listen`、`subscribe`があります。通常のclient APIと異なり、readiness barrierを越えてただちに通信します。

::: warning contextを保存しない
connection setup contextは現在準備しているconnectionにだけ有効です。setup完了後やconnection終了後に再利用せず、ready後も必要な操作は通常のclient APIで作成してください。
:::

## resourceを所有期間へ結び付ける

setup contextの`defer()`へdisposerを登録すると、登録と逆順に一度ずつ実行されます。同期・非同期のどちらも利用できます。

```ts
async setupConnection(ctx) {
  const channel = await openChannel();

  ctx.defer(async () => {
    await channel.close();
  }, { name: "channel" });

  const stop = channel.onMessage(handleMessage);
  ctx.defer(stop, { name: "channel-listener" });
}
```

この例では、終了時に`channel-listener`、`channel`の順で解放します。setup途中で失敗した場合も、そのsetupで登録済みのresourceをrollbackします。

setup hook自体がdisposerを返す書き方もできます。

```ts
setupConnection(ctx) {
  metrics.start(ctx.connection);
  return () => metrics.finish(ctx.connection);
}
```

cleanupが失敗しても、残りのcleanupと本来のclose/drop処理は継続します。失敗は`resource-cleanup-failed` diagnosticとして観測できます。

## openとcloseの境界

- activeなsessionがある状態で再び`open()`すると、同期的に`UniplsInvalidUsageError`を投げます。
- `close()`は冪等で、既にclosedなら何もしません。
- `close()`は再接続待機、進行中operation、session/connection resourceを終了します。
- close完了後の次の`open()`は、新しいsessionを作ります。
- 古いconnectionから遅れて届いたeventやsetup完了は、新しいsessionへ影響しません。

`close()`のPromiseはresource cleanupとWebSocket closeの完了まで待つため、アプリケーションの終了処理では必ずawaitしてください。

## readiness待機中のtimeout

通常operationのtimeoutは、readyになった時点ではなくoperationを受け付けた時点から始まります。

```ts
const opening = client.open(slowProvisioner);
const pending = client.request({ query, selector, timeout: 1_000 });
```

provisioningに1秒以上かかれば、queryをまだ送信していなくても`pending`はtimeoutします。接続準備とは別に、利用者が待てる全体時間を指定するための契約です。
