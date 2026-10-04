# エラーと診断

`unipls`は、呼び出しを続けられない失敗と、接続やoperationを継続しながら観測できる診断情報を分けています。

## 高レベルのdomain error

通常の利用コードは、package rootからexportされる次のerrorで失敗を分類できます。

| error                       | 意味                                             |
| --------------------------- | ------------------------------------------------ |
| `UniplsInvalidUsageError`   | 現在のlifecycleで受け付けられない呼び出し        |
| `UniplsOpenError`           | sessionが一度もreadyになれず終了した             |
| `UniplsClosedError`         | 利用者の`close()`によってoperationが終了した     |
| `UniplsDroppedError`        | drop後にoperationまたはsessionを回復できなかった |
| `UniplsTimeoutError`        | operationのtimeoutへ到達した                     |
| `UniplsBufferOverflowError` | AsyncIterableの未処理messageがbuffer上限を超えた |

```ts
import { UniplsClosedError, UniplsDroppedError, UniplsTimeoutError } from "unipls";

try {
  await client.request({ query, selector, timeout: 5_000 });
} catch (error) {
  if (error instanceof UniplsTimeoutError) {
    showRetryButton();
  } else if (error instanceof UniplsDroppedError) {
    reportDrop(error.drop, error.attempts);
  } else if (error instanceof UniplsClosedError) {
    // 利用者が画面を閉じたなど、期待された終了
  } else {
    throw error;
  }
}
```

`UniplsOpenError`と`UniplsDroppedError`は、接続試行履歴、terminal outcome、元の`cause`、必要に応じてcanonical dropを保持します。libraryが所有するerrorとmetadataはfreezeされていますが、利用者が投げた`cause`自体はcloneもfreezeもしません。

## 入力エラーは同期的に投げる

必須値やoptionの型、timeoutやbuffer capacityの範囲は、session確認や非同期処理より前に検証します。

```ts
// selectorがないため、その場でTypeError
client.request({ query } as never);

// timeoutが正の有限値でないため、その場でRangeError
client.next({ selector, timeout: 0 });
```

Promiseのrejectだけを監視していると取り逃すため、動的な入力を渡す箇所では通常の同期例外として扱ってください。

## streamは終了結果を値で返す

`listen()`と`subscribe()`の`closed`は、cleanup完了後に一度だけ解決し、失敗時にもrejectしません。

```ts
const result = await subscription.closed;

if (result.ok) {
  switch (result.reason) {
    case "terminated":
      console.log(result.message);
      break;
    case "unsubscribed":
    case "closed":
      break;
  }
} else {
  report(result.reason, result.error);
}
```

正常終了は`terminated`、`unsubscribed`、`closed`です。異常終了は`aborted`、`timeout`、`open-error`、`dropped`、`buffer-overflow`、`callback-error`、`fatal-error`です。

## 構造化ログ

message単位の変換失敗、callbackの例外、lossy bufferによる破棄、extensionやcleanupの失敗などは、client作成時に指定する同期`logSink`へ渡されます。`Unipls`と`UniplsSocket`の両方で指定できます。

```ts
import { Unipls, type UniplsLog } from "unipls";

const client = new Unipls({
  url,
  logSink: (log: UniplsLog) => {
    logger.log(log.level, log.message, {
      event: log.event,
      ...log.context,
      cause: log.cause,
    });
  },
});
```

ログの公開契約は`level`、`event`、`message`、任意の`context`と`cause`です。`event`と`context`は拡張可能で、個別のevent名やmetadataの網羅的なunionではありません。`debug`は詳細な正常経路、`info`は重要な状態変化、`warning`は処理を継続できる異常や情報損失、`error`は処理単位や必須のsubsystemの失敗を表します。sinkの例外はlibraryへ伝播せず、sinkを省略してもconsoleへ代替出力しません。

### ログがoperationを終了するとは限らない

既定では、次の失敗を他のmessageやconsumerから隔離し、処理を継続します。

- 一つのraw messageのdeserialization failure
- `selector`または`terminator`の例外
- stream callbackの同期例外
- drop detectorの監督対象callbackやtaskの失敗
- disposerの失敗

`predicateError: "fail"`や`callbackError: "unsubscribe"`を選んだ場合だけ、該当operationも終了します。

### message本体を含めない

ログ収集先へ機密情報が流れないよう、message関連ログはapplication message本体を含みません。

- deserialization failure: connection内のsequence、raw inputのkindとsize
- predicate/callback failure: operation scope、policy、cause
- lossy buffer: strategyとcapacity

必要な相関情報は、session ID、connection ID、operation IDを使って付加してください。

## 公開event

高レベルclientで購読できるeventは次の7種類です。

| event       | 通知されるとき                        |
| ----------- | ------------------------------------- |
| `open`      | connectionがreadyになった             |
| `message`   | raw messageを利用者型へ変換できた     |
| `failed`    | connectionのprovisioningが失敗した    |
| `dropped`   | readyだったconnectionを失った         |
| `closed`    | 論理sessionが終了した                 |
| `lifecycle` | lifecycle snapshotが遷移した          |
| `reconnect` | replacement connectionがreadyになった |

```ts
const stop = client.on("message", ({ message, session, connection }) => {
  observe(message, { session, connection });
});

stop();
```

event listenerの例外は、他のlistenerやclient lifecycleから隔離されます。`logSink`はログの発生箇所で同期的に呼ばれます。

## 低レベルsocketのerror

`unipls/socket`は高レベルdomain errorとは別に、`UniplsSocketClosedError`と`UniplsSocketDroppedError`を公開します。通常の`Unipls`利用コードではこれらへ依存せず、高レベルerrorだけを扱えます。
