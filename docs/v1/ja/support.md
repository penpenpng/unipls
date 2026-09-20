# 対応runtime

uniplsのJavaScript配布物はES2022をtargetとし、次のruntimeを公式にサポートします。

| runtime | support policy |
| --- | --- |
| Chrome | 最新2安定版 |
| Firefox | 最新2安定版 |
| Safari | 最新2安定版。CIでは対応するWebKitを検証 |
| Node.js | `>=22.4.0` |
| Deno | `>=2.0.0` |
| Bun | `>=1.2.0` |

CIではNode.js、Deno、Bunの最低版と最新stableを検証します。browserは最新2系統のPlaywright releaseごとにChromium、Firefox、WebKitを検証します。

## WebSocket

4runtimeすべてで`globalThis.WebSocket`を既定transportとして使用します。moduleをimportしただけではglobalを参照せず、`Unipls`または`UniplsSocket`を構築した時点で解決します。

実行環境にglobal WebSocketがない場合やtest double、任意のtransport実装を使う場合は、constructor optionへ`WebSocket`を注入してください。注入したconstructorはglobalより優先されます。polyfillや`ws` packageはuniplsにbundleしません。

## AbortSignal

operationのuser signal、resource scope、timeoutを合成するため、nativeの`AbortSignal.any`を必須とします。library独自のpolyfillは提供しません。合成signalは最初にabortしたsourceの`reason`を同じobject identityで保持します。

## platform別entry point

- `unipls`: 高レベルclientとruntime非依存の拡張契約
- `unipls/socket`: 低レベルWebSocket client
- `unipls/browser`: browser固有の`NetworkDropDetector`

root importは`window`へアクセスせず、browser固有moduleを読み込みません。`unipls/browser`をBrowser以外で利用した場合の動作は保証しません。
