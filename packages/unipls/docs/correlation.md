# correlation helper検証記録

## 結論

初期releaseにはcorrelation helper、key extractor、route hintを追加しません。現時点の計測と具体例では、selectorの短い比較を公開APIと新しいfailure semanticsで置き換える必要性を確認できませんでした。

この判断は将来の追加を妨げません。内部の`MessageDispatcher`はoperation lifecycleから分離されているため、必要性が確認された時点で候補集合だけを絞る実装を追加できます。

## selector fan-outの計測

`benchmarks/message-dispatcher.bench.ts`は、実装中の`MessageDispatcher`へrequest IDを待つrequestとtopicを待つsubscriptionを半数ずつ登録し、どの条件にも一致しないmessageを配送します。全operationがactiveなまま毎回selectorを評価するため、保守的なfan-out scenarioです。

実行方法:

```sh
mise exec -- pnpm --filter unipls benchmark:correlation
```

2026-09-21にNode.js 22.13.1、Darwin arm64で測定した一例:

| active operation数 | 1 messageの平均配送時間 | 1秒あたりの配送回数 |
| ---: | ---: | ---: |
| 1 | 0.0001 ms未満 | 約26,500,000 |
| 10 | 約0.0001 ms | 約8,300,000 |
| 100 | 約0.0009 ms | 約1,060,000 |
| 1,000 | 約0.0193 ms | 約51,900 |
| 10,000 | 約0.1911 ms | 約5,200 |

結果は環境とmessage/selectorの処理内容に依存し、性能保証ではありません。候補数に対して線形に増えることは確認できましたが、通常想定される数十から数百の同時operationでkeyed dispatcherを必須とする負荷は観測されませんでした。

## 具体的な利用コード

request IDでresponseを待つ場合、利用者が追加するcorrelation処理はselector内の比較です。message種別やpayloadの検証はhelperがあっても必要です。

```ts
const response = await client.request({
  query: { type: "get-user", requestId, userId },
  selector: (message) => message.type === "user" && message.requestId === requestId,
});
```

topicを購読する場合も同様に一つの比較で表現できます。複数の購読が同じtopicを待つ場合は、全購読が同じmessageを受け取れる現在のbroadcast semanticsが自然です。

```ts
const events = client.listen({
  selector: (message) => message.type === "event" && message.topic === topic,
});
```

現在のsource、公開例、contract testには、correlation mapの作成や解除、timeout、再接続処理を利用者が重複実装する例はありませんでした。重複しているのはdomain schemaに属する短い比較だけであり、coreが特定のmessage envelopeを知る根拠にはなりません。

## API候補の比較

| 候補 | 利点 | 課題 |
| --- | --- | --- |
| correlated view | extractorを一度指定でき、既存APIへ追加的に構築できる | viewに属する全operationへkey欠落・抽出失敗の契約が必要 |
| operationごとのroute hint | operation単位でkeyを明示できる | 全operation optionへrouting概念が漏れ、selectorとhintの不一致を利用者が管理する必要がある |

将来必要になった場合は、既存APIを変更しないcorrelated viewを第一候補とします。ただし、query factoryとcustom recoveryは再送時にqueryとselectorを変更できるため、固定route hintでは古いkeyを参照する危険があります。公開形は実利用のprotocolを基に改めて検証します。

候補選択の最適化が既存の意味を変えないため、将来の実装には次を要求します。

- keyがないmessageはkeyed bucketへ直接配送せず、selector-only operationには従来どおり配送する。
- key extractorが失敗したmessageはbroadcastへfallbackし、候補の取りこぼしやoperationの暗黙終了を起こさない。
- 同じkeyのoperationが複数あればbucket内の全operationへfan-outし、各selectorを最終判定として実行する。
- recoveryでqueryまたはselectorが変わる場合、operationを受信可能に戻す前にkeyも同じlifecycle transactionで更新する。安全にkeyを決定できなければbroadcastへfallbackする。
- timeout、drop/recovery、cleanup、diagnosticは既存のoperation lifecycleを使い、router側へ複製しない。

これらを満たす実装が可能でも、今回の計測だけでは初期releaseへ公開helperを追加しません。
