# コアコンセプト達成のための実装計画

## 現状評価

現実装には、5 種類の通信操作、serializer/deserializer、provisioning、drop detector、reconnector、操作ごとの recovery policy という主要部品がそろっています。現行テスト 84 件もすべて成功しています。

ただし、テストが示す個別シナリオと、[コアコンセプト](./overview.md) が要求するライフサイクル全体の不変条件にはまだ差があります。特に「論理セッションと物理接続の分離」「回復を断念したときの終了」「古い接続の隔離」「公開パッケージとしての利用可能性」は完成していません。

以下では、差分を「未完成」「誤り」「成立はするが最適ではない」に分けます。優先度は P0 が公開前の必須条件、P1 がコア契約の完成、P2 が保守性と使いやすさの改善です。

## まだ完成していない部分

### P0: パッケージの公開面を完成させる

- `package.json` の `exports` は `./package.json` しか公開しておらず、生成済みの `dist/index.mjs` と型宣言を package root から import できない。
- `Unipls` の public method が引数に使う `UniplsParams`、各操作の params、subscriber、recovery 関連型が root から export されていない。
- constructor option である drop detector の interface と、同梱 detector も root から利用できない。
- `description`、対応 runtime、必要な WebSocket/AbortSignal 機能など、配布物の最低限の契約が未定義である。

`exports`、runtime entry、types entry、公開型を整え、梱包した tarball を別の fixture project から import して型検査・実行する smoke test を追加する。低レベルの `UniplsSocket`、close code、socket error を正式な public API にするかは、この時点で意図的に決める。

### P0: 静的検査を release gate として動作させる

`build` と test は成功する一方、現在の `check` script は `vite.config.ts` の読み込み時に `ERR_UNKNOWN_FILE_EXTENSION` で停止し、format、lint、型検査を開始できない。さらに package 単体では TypeScript compiler を直接実行できず、build 以外の独立した型検査経路がない。

Vite+ の設定ファイル形式と script を修正し、format check、lint、型検査、test、build、consumer smoke test を CI の独立した release gate にする。失敗した検査が後続検査を隠さない構成にする。

### P0: 再接続の最終結果を定義する

現在の reconnector の `cancel()` は再接続しないだけで、`wait` 中の操作へ「回復を断念した」ことを通知しない。reconnector の `setup()` が例外を投げた場合も握りつぶされる。接続生成または provisioning に失敗した再接続も、経路によっては次の試行へ進まず、操作が永久に待機する。

再接続サイクルには少なくとも `succeeded`、`retrying`、`cancelled/exhausted`、`session-closed` の終端を持たせる。終端はすべての待機操作へ伝播し、timeout や外部 abort がなくても必ず settle できるようにする。接続失敗と provisioning 失敗を同じ試行結果として reconnector に返し、次の policy 判断に直前エラーを渡す。

### P1: 初回接続失敗の方針を確定する

初回の `open()` が timeout、接続拒否、provisioning 失敗になったとき、reconnector の対象にするか、まず `open()` を失敗させるかが一貫していない。コードにもこの判断を保留する TODO がある。

「初回 open の Promise」と「open intent を維持する自動回復」を分けて定義する。少なくとも、どの失敗が recoverable か、`open()` は最初の失敗で reject するか回復成功まで待つか、明示的 `close()` まで再試行可能かを contract test にする。

### P1: 未検証のライフサイクルを contract test にする

現在のテストは代表的な成功経路をよく覆う一方、次の不変条件を検証していない。

- 論理セッション ID は再接続後も同じで、`isSessionBeginning` は最初の provisioning だけ `true`
- 遅延 reconnector の待機中に開始した全操作が、定義した方針どおりに送信、継続、失敗する
- reconnector の cancel、setup failure、再接続失敗で待機操作が終了する
- 古い接続の message、close、provisioning 完了が現在の接続へ影響しない
- provisioner、message factory、subscriber callback、detector が例外を投げても cleanup と他操作の通知が行われる
- server 主導の close と利用者の `close()` を意図どおりに分類する
- 二重 `open()`、drop 中の `open()`、close と reconnect の競合が新しい論理セッションを作らない

実装を直す前にこれらを black-box test として追加し、内部構造ではなく観測可能な契約を固定する。

### P1: timeout と readiness の意味を確定する

現在の operation timeout は provisioning と再接続の待ち時間を含む wall-clock deadline だが、その意味は契約として固定されていない。また、通常の `next` / `listen` が provisioning 中のメッセージを観測してよいかも曖昧である。

timeout を操作開始からの deadline とするか、接続中だけ進む時間とするかを決める。readiness barrier を受信専用操作にも適用するかを決め、provisioning context から作った操作だけが準備中のメッセージを観測できる、という対称なモデルを優先して検討する。

## 現在の実装で誤っている部分

### P0: 論理セッション ID と物理接続 ID が混同されている

`UniplsSessionManager` は `open()` から `close()` までの論理セッションを管理する一方、`UniplsSocket` は物理接続ごとに別の ID を発行する。しかし provisioning context の `session` には後者が渡されている。

その結果、再接続すると provisioning の session ID が変わり、物理接続 ID を記録する `#provisionedSessions` にとって毎回が初回になるため、`isSessionBeginning` も常に `true` になる。reconnector context が示す session と provisioning context が示す session も一致しない。

論理セッションを唯一の session とし、物理接続には別名の connection epoch/ID を内部だけで与える。`isSessionBeginning` は論理セッション自身の状態として保持し、ID の Set で推測しない。

### P0: 古い物理接続のイベントが隔離されていない

socket の raw event は作成時の物理接続を参照するが、公開 event bus には古い接続の message、close、provisioning 完了もそのまま流れる。各操作も現在の connection epoch を確認しない。さらに、待機送信の listener は event の接続を確認せず、実際の送信先には「その時点の現在 socket」を使う。

このため、drop 後に古い provisioning が完了した場合、古い接続の `open` が ready を偽装したり、新しい socket へ準備前の送信を流したりできる。古い close/error が新しい操作を終了させる可能性もある。

物理接続ごとの epoch と AbortSignal を導入し、すべての raw event、provisioning、送信待機をその epoch に束縛する。現在でない epoch のイベントは状態を変更する前に破棄し、接続交代時に古い epoch の全処理を abort する。

### P0: `open()` が検証前に現在の論理状態を書き換える

`Unipls.open()` は、下位 socket が二重接続を拒否する前に provisioner を置き換え、新しい論理セッションを作る。そのため、接続中に誤って `open()` を呼んで例外になっただけでも、次の再接続で別の provisioner と session が使われ得る。

drop 中に pending reconnector を残したまま手動 `open()` する経路にも、古い reconnect action が後から発火する競合がある。遷移の妥当性確認、旧セッションの終了、新セッションの作成、物理接続開始を 1 つの lifecycle coordinator で原子的に行う。

### P0: dropped 状態で開始した操作が settle しない

open intent のまま reconnector の判断を待っている期間、state は `dropped` になる。この期間に `cast`、`request`、`subscribe` を開始すると、送信も再接続 event の登録も行わない経路があり、timeout/abort/close がなければ永久に待つ。

操作開始条件を瞬間的な socket state ではなく論理 session と intent で判定する。open intent 中なら次の ready connection まで待機し、その後に初回送信する。closed session なら同期的に拒否する。待機中に recovery が断念された場合も必ず drop error で終了する。

### P0: close/drop の判定と状態遷移が intent と一致しない

raw close は close code 1000 だけを `closed`、それ以外を `dropped` としている。server が 1000 で一方的に閉じると open intent が残っていても再接続せず、利用者が close した接続が別 code で閉じると state は `dropped` になる。

また、既に dropped の socket を `close()` した経路では `closed` event を出しても state 自体は `dropped` のままであり、socket 生成に失敗して socket がない経路では intent/state を閉じない。

利用者の close intent を最優先し、それ以外の切断を「接続維持が破られた」という観点で分類する。protocol 上の close code は原因情報として保持し、logical state の分類そのものにはしない。`close()` 完了後はすべての経路で必ず closed state に収束させる。

### P1: `castForce()` が connecting 中には barrier を越えない

`requestForce` と `subscribeForce` は raw open を待てるが、`castForce` は通常の `open` event、つまり provisioning 完了まで待つ。公開説明と force 系の対称性に反する。

force 能力を provisioning context 内部に閉じ込めたうえで、すべて同じ「socket open 後、ready 前でも通信可能」という primitive を使う。

### P1: message factory の例外で operation scope がリークする

query factory は scope 作成後に保護なしで評価される経路がある。そこで例外が出ると caller へ同期 throw する一方、作成済み listener と timer は残る。event listener 内で評価された場合は event 配信まで中断し得る。

factory 評価を operation state machine の一部として捕捉し、単発操作は reject、stream 操作は fatal error として一度だけ終了させ、必ず cleanup する。

### P1: subscriber callback の例外で finalization が失われる

`onTerminated`、`onFatalError`、`onUnsubscribed` などは、内部状態を resulted にした後、cleanup を起動する前に呼ばれる。callback が throw すると abort/finally/event listener の解放まで到達せず、終了済みだが破棄されない操作になる。event bus も listener 例外を隔離しないため、1 利用者の callback が他の操作への同一 event 配信を止め得る。

内部の終了と cleanup を先に確定し、利用者 callback は隔離して呼ぶ。callback error の報告方法は別途決めるが、他 listener と lifecycle を壊してはならない。全終了経路で finalization がちょうど一度行われることをテストする。

### P1: provisioning 中の永続 listen が重複し得る

provisioning context の `listen` は drop 後も待機継続する一方、provisioning 自体は物理接続ごとに再実行される。`isSessionBeginning` の誤りも重なり、同じ session-scoped listener が再接続ごとに追加され得る。context の型は unsubscribe も返さない。

provisioning で登録する資源を、論理セッションに属するものと物理接続に属するものに分ける。session-scoped 登録は最初の一度だけ作成して close で破棄し、connection-scoped 登録は drop で破棄して次の provisioning で作り直す。context API も必ず cleanup handle を返す。

### P1: detector の setup が部分失敗すると cleanup できない

複数 detector の setup 中に後続 detector が throw すると、それ以前に得た disposer が manager に保存されずリークする。detector の callback 例外も接続 lifecycle から隔離されていない。

setup を transactional にし、途中失敗時は設定済み detector を逆順に破棄する。disposer は冪等にし、drop、close、provisioning failure、epoch 交代のすべてで一度だけ実行する。

### P1: 公開 event 型が広すぎ、内部状態を露出する

public event 型を `Record<string, unknown>` と交差しているため、生成された型宣言の `on()` は任意の文字列 event を受け入れる。event payload には public interface ではない mutable な socket session object も含まれる。

公開 event の有限 union/map を明示し、payload は session ID、connection ID、close metadata などの immutable snapshot にする。内部 event bus と public event contract を分離する。

### P1: 再接続履歴が外部から変更できる

reconnector context の `sessionAttempts` と `allAttempts` は内部配列そのものを mutable として渡す。policy が配列を書き換えると、以後の retry 判断と event が壊れる。

readonly snapshot を渡し、履歴の所有権を session manager に限定する。試行開始時刻、終了時刻、結果、原因を 1 つの immutable attempt record にまとめる。

### P2: heartbeat の待機 listener が累積する

heartbeat の sleep は timer が正常終了した後も AbortSignal の listener を外さない。長時間動作すると接続ごとに listener が増え続ける。

timer 完了時と abort 時の双方で対になる cleanup を行う共通 abortable delay を用意する。

### P2: 終了理由と error payload の契約が一致しない

型コメントでは finalization の `error` は `fatal-error` の場合だけとされるが、実装は `closed`、`dropped`、`aborted` にも error/reason を格納する。利用者が型コメントを信頼できない。

終了理由を discriminated union にし、各 reason が error を持つかを型で表す。Promise 系の error taxonomy と stream 系の終了値にも同じ分類を使う。

## 誤りではないが、コンセプト達成の手段として最適ではない部分

### P1: callback の集合より first-class な stream handle が適する

現在の `listen` / `subscribe` は subscriber callback の集合と unsubscribe 関数を返す。表現可能ではあるが、結果、終了、error、cancel が複数箇所に分かれ、callback 例外や cleanup の順序を複雑にしている。受信側に backpressure を表す余地もない。

`AsyncIterable`、または `unsubscribe`、`closed` Promise、終了理由を持つ subscription handle をコアにし、callback API を adapter として提供する案を検討する。単発と複数結果で abort/error の語彙を共有しやすくなる。

### P1: force 系を一般公開するより capability を限定する

`castForce` / `requestForce` / `subscribeForce` を通常 client に公開すると、利用者が readiness barrier を任意に破れる。必要なのは provisioning が準備通信を行う capability であり、通常操作の恒常的な別バリアントではない。

force primitive は内部化し、接続 epoch に束縛された provisioning context だけへ渡す。高度な用途で公開する場合も、危険性と有効期間が型に現れる専用 connection handle にする。

### P1: 高レベル client と低レベル socket の同時公開は契約を二重化する

現在は `Unipls` に加えて `UniplsSocket`、socket 固有 error、close code も root から export している。両方を安定 API にすると、state、session、event、provisioning の意味を二重に維持する必要があり、内部の epoch 設計も固定される。

主目的が回復可能な型付き操作である以上、まず高レベル client と拡張 interface を public contract にする。低レベル層が実利用に必要だと確認できた場合だけ、内部クラスそのものではなく別 entry point の小さな transport interface として設計する。

### P1: boolean selector だけでは大規模な相関処理が重複する

selector による protocol 非依存性はコアに合っている。一方、多数の同時 request が毎メッセージすべての selector を実行し、同じメッセージが複数 request を解決できるため、典型的な request ID ベースの利用者は同じ相関処理を繰り返す。

selector を基本 primitive として維持しつつ、key extractor と correlation map、topic router などを opt-in helper として上に構築できる extension point を検討する。コアが特定 envelope を強制しないことは維持する。

### P2: lifecycle が複数の state holder に分散している

現在は高レベル session manager、socket session、connection state、intent、provisioned ID Set、reconnector cleanup が別々に状態を持つ。この分散が session ID の混同と競合を生んでいる。

論理セッション、現在の connection epoch、再接続サイクルを所有する単一 coordinator を置き、操作と extension は immutable snapshot と signal だけを見る構成が適する。状態遷移を reducer/state machine として列挙すると、無効な組み合わせを作りにくい。

### P2: retry preset の既定値と deadline を policy object に集約する

現在は receive-only 操作が既定で `wait`、query を持つ操作が既定で `fail` となる。この非対称性自体は、暗黙の再送を避けるという点で合理的である。ただし reconnector の有無によって実際の終了が変わり、timeout の時計も別に動くため、利用者が全体像を把握しづらい。

`onDrop`、deadline、再送安全性を操作 policy として一か所に正規化し、開始時に確定した policy snapshot を操作が保持する。既定値は「送信を伴わない観測は継続可能、送信の再実行は明示が必要」という原則から導く。

### P2: error class と診断 event を整理する

現在は高レベル error と socket error が並存し、reconnector setup error のように外へ出ない失敗もある。公開 error には安定した `name`、cause、close metadata、session/connection 情報がない。

利用者が分岐する少数のドメイン error と、観測用の診断情報を分ける。内部 transport error は `cause` として保持し、通常の操作契約を低レベル error に依存させない。

## 推奨する実装順序

1. lifecycle、session、connection epoch、reconnection outcome、timeout/readiness の contract test を追加する。
2. 単一 lifecycle coordinator を導入し、論理 session と物理 connection epoch を分離する。
3. close/drop/reconnect/provisioning を epoch-bound な state machine に統合し、すべての終端を通知する。
4. 5 操作を同じ operation lifecycle 上に載せ、dropped 中の開始、factory/callback 例外、cleanup を統一する。
5. provisioner、detector、reconnector の所有期間と失敗時 cleanup を揃える。
6. 公開 API を選別し、root exports、型、package metadata、consumer smoke test を完成させる。
7. その後に stream handle、correlation helper、診断 API などの ergonomics を検討する。

各段階で既存の 84 テストを回帰テストとして維持する。ただし現在の内部クラス分割や event payload まで固定せず、[コアコンセプト](./overview.md) に記した観測可能な振る舞いを優先する。
