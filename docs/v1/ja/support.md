# 対応環境

`unipls`のJavaScript配布物はES2022をtargetとしています。

## 対応runtime

| runtime | support policy                          |
| ------- | --------------------------------------- |
| Chrome  | 最新2安定版                             |
| Firefox | 最新2安定版                             |
| Safari  | 最新2安定版。CIでは対応するWebKitを検証 |
| Node.js | `>=22.4.0`                              |
| Deno    | `>=2.0.0`                               |
| Bun     | `>=1.2.0`                               |

CIではNode.js、Deno、Bunの最低版と最新stableを検証します。browserは最新2系統のPlaywright releaseについて、Chromium、Firefox、WebKitでpackageの動作を確認します。

## 必要なplatform API

### WebSocket

すべての対応runtimeで`globalThis.WebSocket`を既定のtransportとして使います。moduleをimportしただけではglobalへアクセスせず、`Unipls`または`UniplsSocket`を構築した時点で解決します。

実行環境にglobal WebSocketがない場合や、test double、任意のtransport実装を使う場合は、constructor optionへ`WebSocket`を注入してください。注入したconstructorがglobalより優先されます。

```ts
const client = new Unipls({
  url,
  WebSocket: MyWebSocket,
});
```

WebSocket polyfillや`ws` packageはbundleしません。

### AbortSignal.any

operationのuser signal、resource scope、timeoutを合成するため、nativeの`AbortSignal.any`を必要とします。library独自のpolyfillは提供しません。

合成したsignalがabortされた場合、最初にabortしたsourceの`reason`を同じobject identityで保持します。

## entry point

| import先                | 内容                                                                  | 利用環境            |
| ----------------------- | --------------------------------------------------------------------- | ------------------- |
| `unipls`                | 高レベルclientとruntime非依存の拡張契約                               | すべての対応runtime |
| `unipls/socket`         | 低レベルWebSocket client                                              | すべての対応runtime |
| `unipls/reconnectors`   | 再接続policyと`ImmediateReconnector`、`ExponentialBackoffReconnector` | すべての対応runtime |
| `unipls/drop-detectors` | heartbeatとofflineのdrop detector                                     | すべての対応runtime |

`NetworkDropDetector`は`setup()`でoffline listenerを登録するときに`window`へアクセスします。`unipls/drop-detectors`のimport時にはbrowser APIへアクセスしません。

## CIで確認する範囲

公開packageを一度tarballにし、isolatedなconsumerへinstallしてから検証します。これにより、repository内のsourceを偶然参照できる状態ではなく、実際に配布されるentry point、型定義、runtime dependencyを確認します。

browser検証も同じtarballを使います。ただし、CIで確認できるのは選択したruntimeとbrowser engine上の互換性です。application固有のWebSocket server、network環境、proxy、切断条件まで保証するものではありません。
