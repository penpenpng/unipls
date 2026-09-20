# 初期release監査記録

この文書はTask 15で行ったrelease candidate監査の結果です。規範的な公開契約は[実装タスクとdecision record](./tasks.md)および[コアコンセプト](./overview.md)です。

## behavior matrixとcontract test

### lifecycle状態遷移

| 契約 | 主なcontract test |
| --- | --- |
| idleからinitial attemptを開始し、connecting、provisioning、openへ進む | `lifecycle.spec.ts`「初回 ready まで同一性が安定した不変の snapshot を通知する」、`open-provisioning.spec.ts` |
| initial attemptの失敗、待機、retry、terminal failure | `reconnection-engine.spec.ts`の初回接続・provisioning失敗scenario、`close-drop-classification.spec.ts`の初回open error scenario |
| ready後のdrop、同一sessionでの回復、connection ID更新 | `lifecycle.spec.ts`「回復時は論理セッションを維持して接続 ID を更新する」 |
| recovery attemptの失敗、再試行、cancel、exhaustion、reconnector failure | `reconnection-engine.spec.ts`、`close-drop-classification.spec.ts`「回復の終端結果」 |
| active phaseでのuser closeと進行中attemptのaborted history | `reconnection-engine.spec.ts`「初回 policy 待機中の close と stale action を session-closed に収束させる」、`close-drop-classification.spec.ts` |
| stale transport/provisioning/detector actionの無効化 | `transport-epoch-isolation.spec.ts` |
| closedでのclose冪等性と次のopenでの新session | `lifecycle.spec.ts`「前のセッション終了後の open で新しい論理セッションを作る」 |

### operation behavior

| operation | closed、ready待機、open、recovery、drop policy、成功結果を検証する主なtest |
| --- | --- |
| `cast` | `cast.spec.ts`のready待機と送信、`operation-lifecycle.spec.ts`の5種類拒否、recovery中受付、factory failure、全待機段階timeout、`serialization.spec.ts`の変換とserializer failure |
| `next` | `next.spec.ts`のmessage選択とfail/wait、`operation-lifecycle.spec.ts`のready境界、broadcast、predicate policy、recovery中受付、abort/timeout/cleanup |
| `request` | `request.spec.ts`の送信後観測、`operation-lifecycle.spec.ts`のrecovery中の初回送信、fail/wait/resend、custom recovery、`serialization.spec.ts`のserializer failure |
| `listen` | `listen.spec.ts`の選択・配送・終端とfail/wait、`stream-operation.spec.ts`のcallback/iterator delivery、buffer、close/abort/drop、recovery中受付 |
| `subscribe` | `subscribe.spec.ts`の送信・配送・終端、fail/wait/custom recovery、timeout/abort/close、`stream-operation.spec.ts`のfactory failureと共通stream終了契約、`serialization.spec.ts`のserializer failure |

必須値、callback、policy、signalの不正とtimeout/buffer範囲は、`operation-lifecycle.spec.ts`と`stream-operation.spec.ts`でsession確認より先の同期errorとして検証します。provisionerのobject形状と削除済みfunction shorthandの拒否は`open-provisioning.spec.ts`で検証します。

### 終了結果と競合

`stream-operation.spec.ts`はterminator、unsubscribe、iterator return、session close、initial open failure、drop、timeout、abort、buffer overflow、callback failure、factory failureを検証します。Promise系operationのclose、drop、timeout、abort、predicate/factory/serializer failureは`operation-lifecycle.spec.ts`が検証します。同一値のerror identity、frozen finalization、first-wins、終了後の非再開も同じtest群で固定しています。

## 旧reference testとの差分監査

削除前に`tests/reference/legacy-implementation`の全21ファイルを現行decision recordとcontract testに照合しました。旧assertion自体は仕様根拠にせず、現在も有効なscenarioのうち不足していた次の契約を現行の公開APIから検証するtestとして補いました。

- 公開event listenerの`once`、登録時に返る解除関数、`off()`による解除。
- provisioning中のcloseによる`open()`と保留operationの終了、および次sessionからの分離。
- 低レベルsocketの未接続送信と接続中drop、serializer/deserializerを含むmessage変換。
- `next`、`listen`、`subscribe`のfail/waitと、`subscribe`のcustom recovery、timeout、abort、close。
- 回復成功後も同じsessionへ累積attempt履歴を渡すことと、接続交代ごとのdrop detector setup/cleanup。

一方、deserializer failureで全operationを終了する挙動、legacy subscriber終了callback、provisionerのfunction shorthand、`state`と`intent`の組合せによる公開状態は現行契約で廃止済みのため移植していません。前者は該当messageだけを破棄する契約に、公開状態はdiscriminated unionのlifecycle snapshotに置き換わっています。

## test分類と依存境界

- `tests/contract/**/*.spec.ts`は公開entry pointの`src/index.ts`、`src/socket.ts`、`src/browser.ts`と公開APIだけを使うsupport harnessへ依存する。
- contract testはlifecycle coordinator、operation scope、resource scope、event busなどのinternal moduleを直接importしない。
- `tests/unit/**/*.test.ts`はinternal resource、built-in implementation、test harnessの挙動を検証する。
- 配布package自体のexports、型、runtime behaviorは`tests/package`の隔離tarball consumerで検証する。

## cleanupとleak

| resource | 検証箇所 |
| --- | --- |
| operation timer、native signal合成、dispatcher登録 | `operation-lifecycle.spec.ts`「成功・中断・timeout の各終了経路で operation 資源を一度だけ解放する」 |
| stream timer、buffer、iterator待機 | `stream-operation.spec.ts`のunsubscribe、return、recovery timeout scenario |
| WebSocket handlerとstale event | `transport-epoch-isolation.spec.ts`、package consumer smoke |
| session/connection/setup resource | `provisioning-resource.spec.ts`、`resource-scope.test.ts` |
| detector task、listener、disposer | `drop-detector-lifecycle.spec.ts`、`heartbeat-drop-detector.test.ts` |
| reconnector actionとcleanup | `reconnection-engine.spec.ts`、`close-drop-classification.spec.ts` |

これらのtestはtimer数、listener数、cleanup回数、遅延callback後の状態を観測し、成功、失敗、drop、closeの競合後にresourceが残らないことを確認します。

test runnerの`--detectAsyncLeaks`も全26 file、124 testに対して実行しました。test自体はすべて成功し、検出された非同期resourceは全fileで共通してtest moduleの読込時にVite+ / rolldownのnative bindingが生成する`CustomGC`だけでした。stack traceはライブラリのsession、operation、timer、listener、socket、detector、reconnectorを経由していないためrunner由来のfalse positiveと判断し、ライブラリ資源のleak判定には上記の明示的な観測testを使用します。

## runtimeとpackage artifact

- local consumer testはtarballを一時directoryへinstallし、root/socket/browser entry、DOMなし型検査、global WebSocket、constructor注入、close/drop cleanup、native `AbortSignal.any`、deep import拒否を検証する。
- CIは同じtarball artifactをNode.js `22.4.0`とlatest、Deno `2.0.0`とlatest、Bun `1.2.0`とlatestで実行する。
- browser CIは最新2系統のPlaywright releaseごとにChromium、Firefox、WebKitで`unipls/browser`を含むconsumer smokeを実行する。
- tarballは`dist`、support文書、package metadataだけを含み、sourceやmonorepo aliasを必要としない。

## 文書照合

- `overview.md`はlogical session、transport epoch、readiness、recovery、stream、diagnostic、公開entry pointの現行契約と一致する。
- `support.md`とpackage metadataはNode.js、Deno、Bun、browser、ES2022、WebSocket、`AbortSignal.any`の前提と一致する。
- `plan.md`は実装前の問題一覧を現在形で残さず、完了したP0/P1と次期milestoneを示す。
