# 初期release監査記録

この文書はTask 16で行ったrelease candidate監査の結果です。規範的な公開契約は[実装タスクとdecision record](./tasks.md)および[コアコンセプト](./overview.md)です。

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
| `cast` | `cast.spec.ts`のready待機と送信、`operation-lifecycle.spec.ts`の5種類拒否、recovery中受付、factory/serializer failure、全待機段階timeout |
| `next` | `next.spec.ts`のmessage選択、`operation-lifecycle.spec.ts`のready境界、broadcast、predicate policy、recovery中受付、abort/timeout/cleanup |
| `request` | `request.spec.ts`の送信後観測、`operation-lifecycle.spec.ts`のrecovery中の初回送信、fail/wait/resend、custom recovery |
| `listen` | `listen.spec.ts`の選択・配送・終端、`stream-operation.spec.ts`のcallback/iterator delivery、buffer、close/abort/drop、recovery中受付 |
| `subscribe` | `subscribe.spec.ts`の送信・配送・終端、`stream-operation.spec.ts`のfactory failure、明示resend、共通stream終了契約 |

必須値、callback、policy、signalの不正とtimeout/buffer範囲は、`operation-lifecycle.spec.ts`と`stream-operation.spec.ts`でsession確認より先の同期errorとして検証します。provisionerの削除済みfunction shorthandとhook形状は`open-provisioning.spec.ts`で検証します。

### 終了結果と競合

`stream-operation.spec.ts`はterminator、unsubscribe、iterator return、session close、initial open failure、drop、timeout、abort、buffer overflow、callback failure、factory failureを検証します。Promise系operationのclose、drop、timeout、abort、predicate/factory/serializer failureは`operation-lifecycle.spec.ts`が検証します。同一値のerror identity、frozen finalization、first-wins、終了後の非再開も同じtest群で固定しています。

## test分類と依存境界

- `tests/contract/**/*.spec.ts`は公開entry pointの`src/index.ts`、`src/socket.ts`、`src/browser.ts`と公開APIだけを使うsupport harnessへ依存する。
- contract testはlifecycle coordinator、operation scope、resource scope、event busなどのinternal moduleを直接importしない。
- `tests/unit/**/*.test.ts`はinternal resource、built-in implementation、test harnessの挙動を検証する。
- 配布package自体のexports、型、runtime behaviorは`tests/package`の隔離tarball consumerで検証する。
- `tests/reference/**`はtest runnerと型検査から除外され、新しいsource/testからimportされていない。

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

test runnerの`--detectAsyncLeaks`も全25 file、114 testに対して実行しました。test自体はすべて成功し、検出された非同期resourceは全fileで共通してtest moduleの読込時にVite+ / rolldownのnative bindingが生成する`CustomGC`だけでした。stack traceはライブラリのsession、operation、timer、listener、socket、detector、reconnectorを経由していないためrunner由来のfalse positiveと判断し、ライブラリ資源のleak判定には上記の明示的な観測testを使用します。

## runtimeとpackage artifact

- local consumer testはtarballを一時directoryへinstallし、root/socket/browser entry、DOMなし型検査、global WebSocket、constructor注入、close/drop cleanup、native `AbortSignal.any`、deep import拒否を検証する。
- CIは同じtarball artifactをNode.js `22.4.0`とlatest、Deno `2.0.0`とlatest、Bun `1.2.0`とlatestで実行する。
- browser CIは最新2系統のPlaywright releaseごとにChromium、Firefox、WebKitで`unipls/browser`を含むconsumer smokeを実行する。
- tarballは`dist`、migration/support文書、package metadataだけを含み、sourceやmonorepo aliasを必要としない。

## 文書照合

- `overview.md`はlogical session、transport epoch、readiness、recovery、stream、diagnostic、公開entry pointの現行契約と一致する。
- `migration.md`は削除した旧APIをdeprecated adapterなしで現行APIへ移す方法を示す。
- `support.md`とpackage metadataはNode.js、Deno、Bun、browser、ES2022、WebSocket、`AbortSignal.any`の前提と一致する。
- `plan.md`は実装前の問題一覧を現在形で残さず、完了したP0/P1と次期milestoneを示す。
