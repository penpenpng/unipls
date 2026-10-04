# コアコンセプト

`unipls`は、WebSocketを使うアプリケーションで曖昧になりやすい「いつ通信できるか」「切断後に何をやり直すか」「進行中の処理をどう終えるか」を、明示的な契約として扱います。

## protocolはアプリケーションが決める

`unipls`は、特定のRPC形式やmessage schemaを要求しません。次の要素はアプリケーション側のprotocolに残します。

- JSONやbinaryなどのwire format
- request IDとresponseの対応付け
- topicや購読解除messageの形式
- 認証方法と再開token
- 冪等性、重複排除、順序保証

送信値と受信値は型parameterで表し、wire dataとの変換を`serializer`と`deserializer`へ渡します。どのmessageがoperationに属するかは`selector`で指定します。同じmessageが複数のselectorに一致すれば、該当するすべてのoperationが観測できます。

## sessionとconnectionを分ける

`open()`からterminalな終了までが一つの論理sessionです。その途中で通信が切れ、WebSocketへ接続し直すと、物理connectionだけが入れ替わります。

```text
logical session
├── initial connection
├── replacement connection 1
└── replacement connection 2
```

この区別によって、session全体で一度だけ行う処理と、connectionが替わるたびに必要な処理を分けられます。明示的な`close()`はsessionを終了します。一方、dropは現在のconnectionを失ったという事実であり、回復中は同じsessionが続きます。

実際のsetupとresource管理は[接続とreadiness](./lifecycle.md)を参照してください。

## openとreadyを分ける

WebSocketのopen eventは、transportが通信可能になったことしか示しません。認証、handshake、状態同期、購読の復元が必要なアプリケーションでは、その完了後をreadyと考える必要があります。

`unipls`はconnectionごとの準備をprovisioningとして扱います。

1. WebSocketが開く
2. `setupConnection`が認証や同期を行う
3. setupが成功するとconnectionがreadyになる
4. 待機中の通常operationが送受信を始める

通常operationのtimeoutにはreadyを待つ時間も含まれます。準備が終わらないconnectionへ通常のmessageが先に流れることはありません。

## 通信を5つの形で表す

受信件数と送信の有無に応じて、通信を5種類のoperationとして表します。

| operation   | 送信 | 結果 |
| ----------- | ---: | ---: |
| `cast`      |    1 |    0 |
| `next`      |    0 |    1 |
| `request`   |    1 |    1 |
| `listen`    |    0 |    N |
| `subscribe` |    1 |    N |

単発operationはPromise、継続的なoperationはcallbackまたはAsyncIterableで結果を受け取ります。timeout、abort、drop、closeなどの終了経路は、競合しても一度だけ確定します。

詳しいoptionと例は[5つの通信操作](./operations.md)を参照してください。

## 回復を3つの判断に分ける

通信断への対応を一つの「自動再接続」機能にまとめず、次の判断に分けます。

1. **drop detector**: 現在のconnectionを失ったと何を根拠に判断するか
2. **reconnector**: 次のconnectionをいつ試し、いつ断念するか
3. **operation retry**: 進行中のoperationを失敗、待機、再送のどれにするか

connectionを再確立できることと、送信済みのcommandを安全に再送できることは別の問題です。WebSocket clientだけでは、切断直前のmessageがpeerへ届いたかを確定できません。そのため、`request`と`subscribe`は既定で再送せず、`resend`を選ぶ場合は上位protocolで冪等性や重複排除を用意します。

具体的なpolicyは[dropと回復](./recovery.md)を参照してください。

## 終了と診断を分ける

operationを続けられない失敗は、Promiseのrejectまたはstreamの終了結果になります。一つのmessageの変換失敗やcallbackの例外などは、設定した`logSink`へ同期的に通知されます。

message関連ログにはapplication message本体を含めません。監視先へ機密情報が意図せず流れないよう、operation ID、処理方針、raw inputの種類やsizeなど、診断に必要なmetadataだけを公開します。

詳しくは[エラーと診断](./errors.md)を参照してください。

## 高レベルと低レベルを使い分ける

- `unipls`の`Unipls`: session、readiness、5つのoperation、回復、resource管理を使う通常のclient
- `unipls/socket`の`UniplsSocket`: 1回の物理接続とwire dataを直接扱う低レベルclient
- `unipls/reconnectors`: 再接続policyと`ImmediateReconnector`、`ExponentialBackoffReconnector`
- `unipls/drop-detectors`: `HeartbeatDropDetector`と`NetworkDropDetector`

接続管理を自分で構築する必要がなければ、package rootの`Unipls`を使用してください。

## 対象外

次の保証は上位protocolまたは別のstorage・messaging layerの責務です。

- exactly-once配信
- 永続queueとoffline中の無期限な送信保存
- server側の履歴replayや再開token
- application固有の認証方式

`unipls`は、これらを実装するためのlifecycle境界と回復pointを提供しますが、方式そのものは規定しません。
