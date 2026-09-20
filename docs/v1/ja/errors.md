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

## diagnostic event

message単位の変換失敗、callbackの例外、lossy bufferによる破棄、extensionやcleanupの失敗などは、有限な`UniplsDiagnostic` unionとして通知されます。

```ts
const stop = client.on("diagnostic", (diagnostic) => {
  switch (diagnostic.type) {
    case "message-deserialization-failed":
      logger.warn("受信値を変換できませんでした", diagnostic);
      break;
    case "message-predicate-failed":
      logger.error("selectorが失敗しました", diagnostic);
      break;
    case "stream-callback-failed":
      logger.error("stream callbackが失敗しました", diagnostic);
      break;
    case "stream-message-dropped":
      metrics.increment("stream.message_dropped");
      break;
    case "resource-cleanup-failed":
      logger.error("resource cleanupが失敗しました", diagnostic);
      break;
    case "drop-detector-failed":
      logger.error("drop detectorが停止しました", diagnostic);
      break;
    case "reconnector-failed":
      logger.error("reconnectorが失敗しました", diagnostic);
      break;
  }
});
```

diagnostic listenerがない場合、libraryはconsoleへ代替出力しません。必要な監視基盤へ明示的に接続してください。

### diagnosticがoperationを終了するとは限らない

既定では、次の失敗を他のmessageやconsumerから隔離し、処理を継続します。

- 一つのraw messageのdeserialization failure
- `selector`または`terminator`の例外
- stream callbackの同期例外
- drop detectorの監督対象callbackやtaskの失敗
- disposerの失敗

`predicateError: "fail"`や`callbackError: "unsubscribe"`を選んだ場合だけ、該当operationも終了します。

### message本体を含めない

診断収集先へ機密情報が流れないよう、message関連diagnosticはapplication message本体を含みません。

- deserialization failure: connection内のsequence、raw inputのkindとsize
- predicate/callback failure: operation scope、policy、cause
- lossy buffer: strategyとcapacity

必要な相関情報は、session ID、connection ID、operation IDを使って付加してください。

## 公開event

高レベルclientで購読できるeventは次の8種類です。

| event        | 通知されるとき                                      |
| ------------ | --------------------------------------------------- |
| `open`       | connectionがreadyになった                           |
| `message`    | raw messageを利用者型へ変換できた                   |
| `failed`     | connectionのprovisioningが失敗した                  |
| `dropped`    | readyだったconnectionを失った                       |
| `closed`     | 論理sessionが終了した                               |
| `lifecycle`  | lifecycle snapshotが遷移した                        |
| `reconnect`  | replacement connectionがreadyになった               |
| `diagnostic` | library境界で継続可能または継続不能な失敗を捕捉した |

```ts
const stop = client.on("message", ({ message, session, connection }) => {
  observe(message, { session, connection });
});

stop();
```

event listenerの例外は、他のlistenerやclient lifecycleから隔離されます。diagnosticは元の処理結果を確定した後のmicrotaskで通知されます。

## 低レベルsocketのerror

`unipls/socket`は高レベルdomain errorとは別に、`UniplsSocketClosedError`と`UniplsSocketDroppedError`を公開します。通常の`Unipls`利用コードではこれらへ依存せず、高レベルerrorだけを扱えます。
