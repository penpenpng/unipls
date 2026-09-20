# 初期公開契約への移行

この文書は、初期公開契約を確定する前の実装を参照していたcodeを移行するためのメモです。uniplsは未公開パッケージであるため、旧APIをdeprecated adapterとして残していません。

## 高レベルclientと低レベルclientの分離

`UniplsSocket`、socket固有error、close codeはpackage rootから`unipls/socket`へ移動しました。

```ts
import { Unipls } from "unipls";
import {
  UniplsSocket,
  UniplsSocketClosedError,
  UniplsWebSocketCloseCode,
} from "unipls/socket";
```

通常のapplication operationには`Unipls`を使用してください。provisioningやrecoveryを介さずwire-levelの接続を直接制御する場合だけ`UniplsSocket`を使用します。

## 高レベルlifecycle

高レベル`Unipls`の`state`と`intent`は削除しました。現在状態とsession終了理由は`client.lifecycle`の`phase`と判別unionから取得します。

```ts
if (client.lifecycle.phase === "open") {
  console.log(client.lifecycle.session, client.lifecycle.connection);
}
```

通信operationはactiveな論理sessionへ同期的に登録されます。`open()`より前またはsession終了後に呼ぶと`UniplsInvalidUsageError`を同期的に投げます。明示した`timeout`には有限の正数だけを指定できます。

必須のqueryやselectorを省略した入力、callbackやpolicyの型が不正な入力は、session状態を確認する前に`TypeError`として拒否します。削除済みのAPI形状が暗黙に受理されることはありません。

## 接続準備

単一のprovisioner callbackと`isSessionBeginning`による分岐は削除しました。論理sessionで一度だけ行う処理を`setupSession`、物理接続ごとに行う処理を`setupConnection`へ分けます。

```ts
await client.open({
  setupSession(ctx) {
    ctx.defer(stopSessionListener);
  },
  setupConnection(ctx) {
    ctx.defer(clearConnectionState);
  },
});
```

通常operationはprovisioning中のmessageを観測しません。認証やhandshakeで送受信する場合は`setupConnection`へ渡される接続限定の`cast`、`request`、`listen`、`subscribe`を使用します。

高レベルclientの`castForce`、`requestForce`、`subscribeForce`は削除しました。ready前の限定通信は`setupConnection`のcapabilityへ、任意のwire-level制御は`unipls/socket`へ移してください。

functionだけを渡す旧provisioner shorthandは削除しました。`open()`には必須の`setupConnection`と、必要に応じた`setupSession`を持つobjectを渡してください。不正な形はsessionを開始せず同期的に`TypeError`となります。

## drop detectorのentry point

runtime非依存の`HeartbeatDropDetector`はpackage root、`window`へ依存する`NetworkDropDetector`はbrowser専用entryからimportします。

```ts
import { HeartbeatDropDetector } from "unipls";
import { NetworkDropDetector } from "unipls/browser";
```

## streamとcleanup

`listen()`と`subscribe()`は裸の解除関数ではなく、`unsubscribe()`と非rejectingな`closed`を持つsubscriptionを返します。

```ts
const subscription = client.listen({ next: consume });
const stop = () => subscription.unsubscribe();

try {
  await subscription.closed;
} finally {
  stop();
}
```

`Symbol.dispose`、`Symbol.asyncDispose`、`Unipls[Symbol.asyncDispose]`は公開しません。clientの終了と非同期cleanup完了が必要な場合は`try/finally`で`await client.close()`を明示的に呼びます。

```ts
const client = new Unipls({ url });
try {
  await client.open();
  await runApplication(client);
} finally {
  await client.close();
}
```
