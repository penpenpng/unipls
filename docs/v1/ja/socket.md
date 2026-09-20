# 低レベル socket

`unipls/socket`は、1回のWebSocket接続を直接扱うためのentry pointです。接続準備や再接続をアプリケーション側で管理したい場合や、高レベルclientを組み立てる基盤が必要な場合に使います。

通常のアプリケーションでは、論理session、readiness、操作ごとの回復をまとめて扱える`Unipls`を先に検討してください。

## clientを作る

```ts
import { UniplsSocket } from "unipls/socket";

type ClientMessage = { type: "ping"; id: string };
type ServerMessage = { type: "pong"; id: string };

const socket = new UniplsSocket<ClientMessage, ServerMessage>({
  url: "wss://example.com/socket",
  serializer: (message) => JSON.stringify(message),
  deserializer: (data) => JSON.parse(String(data)) as ServerMessage,
});
```

`serializer`と`deserializer`を省略すると、WebSocketが扱うdataをそのまま送受信します。`WebSocket` optionを省略した場合は、構築時の`globalThis.WebSocket`を利用します。

接続の成立を待つ時間は既定で5秒です。変更する場合は`timeout`をミリ秒で指定します。

```ts
const socket = new UniplsSocket({
  url,
  timeout: 10_000,
  WebSocket: MyWebSocket,
});
```

## 接続して送受信する

受信eventを登録してから、接続を開きます。

```ts
const stop = socket.on("message", ({ message, transportEpochId }) => {
  console.log(transportEpochId, message);
});

await socket.open();
await socket.enqueue({ type: "ping", id: crypto.randomUUID() });

stop();
await socket.close();
```

`open()`はWebSocket接続と、指定したprovisionerが完了した時点で解決します。`enqueue()`は接続がopenになるまで待ってから送信し、WebSocket実装の`send()`が正常に戻ると解決します。peerへの到達や処理完了までは保証しません。

`close()`は冪等です。close handshakeがある場合はその完了を待つため、終了処理ではPromiseを`await`してください。

## open前に接続準備を行う

`open()`へprovisionerを渡すと、WebSocketが開いたあと、clientをopenとして公開する前に準備処理を実行できます。

```ts
await socket.open(async (signal) => {
  await loadMetadataRequiredForThisConnection(signal);
});
```

provisionerが完了するまでは`state`が`"provisioning"`になり、通常の`enqueue()`は送信を待ちます。provisionerが失敗すると`open()`も同じ理由で失敗し、その接続は利用できません。

::: warning 高レベルclientとは異なる契約です
低レベルAPIはprovisioner用の通信contextやresource scopeを提供しません。準備中に送信する場合は`enqueue()`の`force` optionが必要で、応答との対応付けやcleanupも利用者が管理します。認証、再接続後の再準備、resourceの所有期間まで一貫して扱う場合は、`Unipls`の`setupConnection`を使ってください。
:::

## eventを観測する

公開eventは接続試行を識別する`transportEpochId`を持ちます。

| event     | 通知されるとき                                   |
| --------- | ------------------------------------------------ |
| `open`    | WebSocketとprovisionerが完了した                 |
| `message` | 受信dataを利用者の型へ変換できた                 |
| `error`   | 受信dataの変換に失敗した                         |
| `failed`  | provisionerが失敗した                            |
| `dropped` | 接続を維持する意図がある間に、現在の接続を失った |
| `closed`  | 明示的なcloseが完了した                          |

```ts
socket.on("error", ({ error, messageSequence, input }) => {
  logger.warn({ error, messageSequence, input }, "messageを変換できませんでした");
});
```

変換に失敗したraw dataそのものは`error` eventへ含まれません。`input`にはdataの種類と、判定できる場合だけsizeが含まれます。そのmessageは破棄されますが、接続は継続します。

`on()`はlistenerの解除関数を返します。同じlistenerを`off()`へ渡す方法と、`{ once: true }`による一度だけの購読も利用できます。

## closeとdropを区別する

`close()`は「この接続を終える」という利用者の意図です。`drop()`は「接続を維持したいが、現在の物理接続はもう使えない」という報告です。

```ts
socket.drop();
```

peer close、transport error、接続timeoutでもdropが通知されます。同じ接続試行で複数の原因がほぼ同時に検出された場合、最初のdrop報告だけが採用されます。

`UniplsSocket`自身はdrop後に再接続しません。再び接続する場合は、`dropped` eventを観測した利用者が新しい`open()`を呼びます。一般的な再接続policyが必要なら、高レベルclientの`reconnector`を利用してください。

## 状態を確認する

```ts
console.log(socket.state); // closed / connecting / provisioning / open / dropped
console.log(socket.intent); // open / close
console.log(socket.transportEpochId);
```

`transportEpochId`は接続試行ごとに増加します。非同期処理の結果が現在の接続にまだ属するかは、`isCurrentTransportEpoch(id)`で確認できます。

## 提供しないもの

低レベルAPIは、次の機能を意図的に提供しません。

- 複数の物理接続をまたぐ論理session
- 自動再接続とbackoff policy
- `cast`、`request`、`listen`、`subscribe`によるmessageの対応付け
- drop後の待機や再送
- setup resourceの自動cleanup
- stream buffer、terminator、終了結果

これらが必要な場合は、package rootの`Unipls`を使用してください。
