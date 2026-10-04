---
layout: home

hero:
  name: unipls
  text: WebSocketの接続と回復を、明示的に
  tagline: readiness、再接続、操作ごとの再送判断、streamの終了までを型付きのライフサイクルとして扱います。
  actions:
    - theme: brand
      text: はじめる
      link: /ja/getting-started
    - theme: alt
      text: コアコンセプト
      link: /ja/concepts

features:
  - title: readyになるまで送らない
    details: WebSocketが開いた直後の認証や状態同期をprovisioningとして扱い、通常の通信を準備完了まで待機させます。
  - title: drop後の判断を分離する
    details: 接続を再確立する判断と、進行中のrequestやsubscribeを再送する判断を別々に指定できます。
  - title: PromiseとAsyncIterable
    details: 1件の応答、継続的な購読、timeout、abort、buffer、終了理由を一貫したAPIで扱えます。
  - title: protocolを決めつけない
    details: JSON、request ID、topic、認証方法はアプリケーション側に残し、必要なライフサイクル境界だけを提供します。
---

## どんなときに使うか

`unipls`は、単にWebSocketを開閉するだけでなく、次の処理をアプリケーション全体で一貫させたいときに向いています。

- 接続直後に認証や状態同期を済ませてから、通常通信を始めたい
- requestとresponse、購読開始と通知を型付きで対応付けたい
- 切断を検知し、再接続の待機方法を自分で決めたい
- 再接続後に「失敗する」「待ち続ける」「再送する」を操作ごとに選びたい
- timeout、abort、明示的なcloseが競合しても、終了を一度だけ確定したい

特定のRPC形式、request ID、topic、exactly-once配信は提供しません。これらはアプリケーション固有のprotocolとして、`selector`、serializer、provisioner、retry policyの上に構築します。

## 最短で試す

```ts
import { Unipls } from "unipls";

const client = new Unipls<string, string>({
  url: "wss://example.com/socket",
});

await client.open();

const response = client.next({
  selector: (message) => message.startsWith("pong:"),
  timeout: 5_000,
});

await client.cast({ query: "ping:1" });
console.log(await response);

await client.close();
```

実際のアプリケーションでは、送受信型、JSON変換、接続準備、回復方針を追加します。[インストールと最初の接続](./getting-started.md)から順に進んでください。
