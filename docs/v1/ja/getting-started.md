# インストールと最初の接続

このページでは、JSONを送受信するclientを作り、接続準備後にrequestを1件実行して、安全にcloseするところまで進みます。

## インストール

```sh
pnpm add unipls
```

```sh
npm install unipls
```

`unipls`はES moduleとして配布されます。JavaScriptのtargetと対応runtimeは[対応環境](./support.md)を参照してください。

## 送受信する型を決める

まず、アプリケーション内で扱う送信値と受信値を定義します。`unipls`はmessage schemaを規定しないため、ここでは例としてJSON objectを使います。

```ts
type ClientMessage =
  | { type: "authenticate"; token: string }
  | { type: "get-profile"; requestId: string };

type ServerMessage =
  | { type: "authenticated"; userId: string }
  | { type: "profile"; requestId: string; displayName: string }
  | { type: "error"; requestId?: string; message: string };
```

## clientを作る

型付きの値とWebSocketが運ぶdataの間を、`serializer`と`deserializer`で変換します。

```ts
import { Unipls } from "unipls";

const client = new Unipls<ClientMessage, ServerMessage>({
  url: "wss://example.com/socket",
  serializer: (message) => JSON.stringify(message),
  deserializer: (data) => JSON.parse(String(data)) as ServerMessage,
});
```

`WebSocket` optionを省略すると、構築時に`globalThis.WebSocket`を使います。test doubleや別実装を使う場合はconstructorを明示的に注入できます。

```ts
const client = new Unipls<ClientMessage, ServerMessage>({
  url,
  WebSocket: MyWebSocket,
  serializer,
  deserializer,
});
```

::: tip 変換失敗の扱い
serializerが例外を投げた場合、送信操作はその値で失敗します。deserializerが例外を投げた場合は、そのmessageだけを破棄し、接続と他の操作は継続します。詳細は[エラーと診断](./errors.md)を参照してください。
:::

## 接続を開く

`open()`は、WebSocketが開き、接続準備が完了したときに解決します。準備が不要なら引数を省略できます。

```ts
await client.open();
```

認証やprotocol handshakeが必要な場合は、`setupConnection`で行います。このcontextの通信はreadiness barrierを越え、準備中の物理接続だけを対象にします。

```ts
await client.open({
  async setupConnection(ctx) {
    const result = await ctx.request({
      query: { type: "authenticate", token: sessionToken },
      selector: (message) => message.type === "authenticated",
      timeout: 5_000,
    });

    if (result.type !== "authenticated") {
      throw new Error("認証応答が不正です");
    }
  },
});
```

`setupConnection`が失敗すると、その接続はreadyになりません。再接続方針を指定していなければ、`open()`は`UniplsOpenError`で終了します。

## requestを送る

`request()`はmessageを送信し、`selector`に最初に一致した受信messageを返します。

```ts
const requestId = crypto.randomUUID();

const message = await client.request({
  query: { type: "get-profile", requestId },
  selector: (candidate) => candidate.type === "profile" && candidate.requestId === requestId,
  timeout: 5_000,
});

if (message.type === "profile") {
  console.log(message.displayName);
}
```

`selector`は受信messageを一つのoperationへ排他的に割り当てるものではありません。同じmessageに一致するすべてのoperationが、そのmessageを観測できます。request IDの発行と一意性はアプリケーション側で管理してください。

## 接続を閉じる

不要になったclientは`close()`し、接続と関連resourceの解放完了を待ちます。既にclosedなら何もしません。

```ts
await client.close();
```

アプリケーションコードでは`try` / `finally`を使うと、途中で失敗してもcloseを待てます。

```ts
await client.open(provisioner);

try {
  await runApplication(client);
} finally {
  await client.close();
}
```

`close()`は論理sessionを終了します。このcloseを原因とする再接続は行われず、進行中の操作も同じsessionとともに終了します。

## ready前に操作を受け付ける

`open()`を呼んだ時点で論理sessionは始まります。Promiseの解決前でも操作を登録でき、実際の送信はreadyになるまで待機します。

```ts
const opening = client.open(provisioner);
const pending = client.cast({ query: message });

await opening;
await pending;
```

一方、`open()`より前や`close()`の完了後に操作を開始すると、`UniplsInvalidUsageError`が同期的に投げられます。

## 次に読む

- [5つの通信操作](./operations.md): cast、next、request、listen、subscribe
- [接続とreadiness](./lifecycle.md): session、connection、provisioning、resource
- [dropと回復](./recovery.md): reconnectorと操作ごとのretry policy
