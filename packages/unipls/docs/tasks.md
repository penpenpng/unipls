# unipls 実装タスク

## この文書の使い方

この文書は、[コアコンセプト](./overview.md) と [実装計画](./plan.md) を、レビュー可能な作業単位と依存順に落としたものです。

- 各タスクは原則として単独でレビュー・merge できる大きさにする。
- 振る舞いを変えるタスクでは、先に black-box の contract test を書き、そのタスク内で green にする。
- 公開パッケージとしての契約を検証するtest fileは`*.spec.ts`とする。公開entry pointから観測できるruntime behavior、型、export、error/event、package consumerとしての利用可否が該当する。
- 公開契約ではない内部実装、utility、test harnessなどのtest fileは`*.test.ts`とする。実装を公開契約として固定しないため、`*.spec.ts`からprivate/internal moduleを直接検証しない。
- `tests/reference/legacy-implementation`以下の`*.reference.ts`とsupport codeは、決定前の旧実装に付属していたtestを凍結した非規範的な参考資料である。test runnerと型検査の対象にせず、本書の決定、公開仕様、互換性、完了条件の根拠にしてはならない。
- 旧referenceから再利用してよいのはscenario、race、mockの着想だけである。期待値をコピーしたりreferenceを修正してgreenにしたりせず、本書から期待値を導出した新しい`*.spec.ts`または`*.test.ts`として書き直す。新しいtest/sourceからreferenceをimportしない。
- 現在の内部クラスや event bus の形ではなく、公開された振る舞いを固定する。
- D1〜D13と「意図的にTask内で確定する詳細」にない新たな公開判断が必要になったら、実装で既成事実を作らずdecision recordへ追記する。
- P2 の拡張は、P0/P1 の公開契約と lifecycle が安定してから着手する。

## 後続実装者への引き継ぎ

この文書は、設計時の会話履歴を読まずに実装を開始するための正本である。D1〜D13は合意済みであり、現在の実装や既存testが異なる場合は、既存挙動ではなく本書の決定を優先する。

参照時の優先順位:

1. `overview.md`の変化させないコアコンセプト。
2. 本書D1〜D13の決定本文と公開contract。
3. 本書のタスク順序、checklist、完了条件。
4. `plan.md`の現状分析。これは問題の由来を説明する資料であり、後から確定した決定を上書きしない。
5. 現在のsourceとtest。既存挙動の把握には使うが、決定と矛盾する挙動を仕様として固定しない。
6. `tests/reference/legacy-implementation`。旧実装で扱っていたscenarioを探すためだけに使い、assertionやAPI形状には仕様上の権威がない。

`公開形の概略`、`公開形の方向性`と明記したcodeは型設計の意図を示す。後のDで確定した語彙やvariantが優先されるため、そのまま転記せず、Task 0とTask 12で一貫した最終declarationへ正規化する。D13の「将来の公開形の例」は初期releaseでは実装・exportしない。

実装を始める前にTask 0の用語、状態遷移表、operation matrixを完成させる。実装中に公開挙動の選択が新たに必要になった場合は、既存codeに合わせて暗黙決定せず、このdecision recordへ追記してからcontract testを書く。

### 実装全体で維持する不変条件

- session coordinatorだけがopen intent、logical session、transport epoch、lifecycle snapshot、recovery cycleを遷移させる。
- lifecycle snapshot、drop、attempt/history、diagnostic、stream finalizationなどの公開recordはshallowなwrapperと所有metadataをruntimeでもfreezeする。opaqueなuser `cause`自体はclone/deep-freezeしない。
- public methodは、必要な検証とsession/operationへの登録を同期区間内で終えてからuser codeや非同期処理へ進む。drop分類もtransport-epoch-scoped settle gateの同期区間で一度だけ確定する。
- transport epochを先に無効化してからcleanupを始める。古いsocket event、detector callback、provisioning完了、reconnect actionは新しいtransport epoch/sessionを変更できない。
- operation、stream、drop、recovery、resource scopeにはそれぞれexactly-onceのsettle/dispose gateを一つだけ置き、複数の終了経路に独立したcleanupを実装しない。
- ready barrierは送信と受信の両方に適用する。barrierを越える通信は作成元epochに束縛されたsetup contextだけが行える。
- cleanupはLIFOで全disposerを一度ずつ試行し終えてから本来のoutcomeを通知する。cleanup failureはdiagnosticであり、元のoutcomeを置換しない。
- deserialization、predicate、callback、extensionのfailureを汎用error eventで全operationへbroadcastしない。D11の所有scopeとpolicyに従う。
- callback/AsyncIterableはdelivery adapterであり、stream lifecycle、buffer、finalization、cleanupの正本を別々に持たない。
- message dispatcherは候補選択だけを担い、selector/terminator、timeout、retry、settle、diagnosticを再実装しない。
- drop detectorの`registrationIndex`は未命名detectorも追跡するためのpublic identityである。一方、cleanup resourceには登録順indexを公開せず、個別判断が必要なresourceだけ任意の一意`name`を付ける。この二つを混同しない。

### operation終了結果の早見表

| 終了原因 | Promise系operation | AsyncIterable | `subscription.closed` |
| --- | --- | --- | --- |
| terminator一致 | 該当なし | terminal messageをyieldせず正常終了 | `{ ok: true, reason: "terminated", message }` |
| `unsubscribe()` / iterator `return()` | 該当なし | 正常終了 | `{ ok: true, reason: "unsubscribed" }` |
| 利用者のsession `close()` | `UniplsClosedError`でreject | 正常終了 | `{ ok: true, reason: "closed" }` |
| initial open terminal failure | `UniplsOpenError`でreject | 同じerrorをthrow | `{ ok: false, reason: "open-error", error }` |
| recovery terminal/drop | `UniplsDroppedError`でreject | 同じerrorをthrow | `{ ok: false, reason: "dropped", error }` |
| timeout | `UniplsTimeoutError`でreject | 同じerrorをthrow | `{ ok: false, reason: "timeout", error }` |
| `AbortSignal` | `signal.reason`でreject | 同じ値をthrow | `{ ok: false, reason: "aborted", error: signal.reason }` |
| buffer overflow `"error"` | 該当なし | `UniplsBufferOverflowError`をthrow | `{ ok: false, reason: "buffer-overflow", error }` |
| `callbackError: "unsubscribe"` | 該当なし | 該当なし | `{ ok: false, reason: "callback-error", error }` |
| factory/serializer/predicate fail-fast等 | 元のerrorでreject | 同じerrorをthrow | `{ ok: false, reason: "fatal-error", error }` |

callback subscriptionは失敗をthrowする呼出元を持たないため、`closed`とdiagnosticで観測する。`closed`はすべての行でrejectせず、cleanup完了後に一度だけresolveする。

### 意図的にTask内で確定する詳細

以下は横断的方針を変更しないtask-localな詳細である。該当タスクの実装前に具体値・最終型をdocumentationとcontract testへ同じ変更で固定する。

- Task 0/12: attempt/history recordの正確なfield、closed lifecycle snapshotの全reason、各IDのopaqueな公開表現。
- Task 9: AsyncIterableの有限な既定buffer capacity。選んだ値をpublic documentationと境界testに明記する。
- Task 13: 4 runtimeで共通に使えるWebSocket structural interfaceの最小field集合。
- Task 13: 既存`state`/`intent`、legacy callback lifecycle、provisioner function shorthandを残すか。`0.0.0`の初期contractでは互換layerを既定で追加せず、残す場合だけ理由、deprecation方針、adapter testを要求する。

これら以外のD1〜D13の事項を、実装上便利という理由で再選択しない。

## 横断的な決定事項

以下は複数タスクの API と contract test を左右する。Task 0 で結論を記録し、関連タスクの完了条件へ反映する。

### D1: 公開 API の境界（決定済み）

決定:

- package root `unipls` は、高レベルの `Unipls` とその拡張契約を公開する。
- 低レベル client も正式な安定 API とするが、package root には混在させず `unipls/socket` entry point から公開する。
- 現在 root にある `UniplsSocket`、socket 固有 error、close code、および低レベル client の public signature に必要な型は `unipls/socket` に移す。高レベル API の signature にも必要な共有型だけは root からも公開してよい。
- `castForce` / `requestForce` / `subscribeForce` は高レベル `Unipls` の public method にしない。
- readiness barrier を越える通信 capability は、現在の transport epoch に束縛された provisioning context だけへ `cast` / `request` / `subscribe` という通常名で渡す。
- provisioning 外で wire-level の高度な制御が必要な利用者には、`unipls/socket` を明示的な escape hatch として提供する。

理由:

- 高レベル API と低レベル API の責務、安定性、error/state contract を entry point 単位で分離できる。
- force は高速版ではなく readiness 保証を破る権限であり、通常 client に公開すると未認証・未同期の接続へ誤送信できる。
- provisioning context に限定すれば、操作を対象 transport epoch とその AbortSignal に束縛し、drop/close 時に確実に無効化できる。

実装上の帰結:

- `unipls` と `unipls/socket` の双方に、独立した export 一覧、型宣言、consumer smoke test を持たせる。
- 高レベルの内部実装が `UniplsSocket` を利用していても、その concrete 型を root の event payload や public declaration に漏らさない。
- `unipls/socket` は正式な public API なので、低レベル state、event、error、serializer/deserializer、接続・送信 semantics も contract test の対象にする。
- force method の単純な移動ではなく、provisioning context が失効後に利用できず、古い transport epoch へ送信できない capability として実装する。
- 既存 root import から移動する低レベル symbol は breaking change として migration note に記録する。

影響するタスク: 10、13、14。

### D2: lifecycle の公開状態（決定済み）

決定:

- 高レベル `Unipls` の状態の正本は、`phase` を判別子とする immutable な discriminated union `UniplsLifecycleSnapshot` とする。
- snapshot は少なくとも `closed`、`connecting`、`provisioning`、`open`、`recovering` を区別する。D4の決定どおりrecoveryのterminal outcome後はactiveな`dropped` phaseを残さず、理由を保持した`closed`へ収束させる。
- phaseごとに存在できる値を型で限定する。たとえば`open`はsession IDとconnection ID、`recovering`はsession ID、canonicalな`UniplsDrop`、attempt historyを持ち、`closed`はactive connectionを持たない。
- `unipls.lifecycle` の readonly getter で現在の snapshot を取得できるようにする。
- `lifecycle` change event は `{ previous, current }` の frozen snapshot を通知する。
- snapshot は遷移時にだけ新しく生成し、同じ状態の間は同じ object identity を返す。型上の `Readonly` だけでなく runtime でも freeze する。
- reconnect/provisioning などの extension context には完全な mutable state を渡さず、その extension に必要な phase の snapshot または必要フィールドだけを readonly で渡す。
- 高レベル API の snapshot に低レベル `UniplsSocket` object や内部 state holder を含めない。
- `unipls/socket` は transport の関心だけを表す独立した low-level lifecycle snapshot を公開する。高レベルの provisioning/recovery phase と低レベル WebSocket state を同じ union に混ぜない。
- 既存の `state` / `intent` を互換性のために残す場合も snapshot から導出する getter とし、状態の正本にはしない。将来的に除去するなら migration note と deprecation を付ける。

公開形の概略:

```ts
type UniplsLifecycleSnapshot =
  | Readonly<{ phase: "closed" }>
  | Readonly<{ phase: "connecting"; session: SessionId; attempt: number }>
  | Readonly<{
      phase: "provisioning";
      session: SessionId;
      connection: ConnectionId;
      attempt: number;
    }>
  | Readonly<{ phase: "open"; session: SessionId; connection: ConnectionId }>
  | Readonly<{
      phase: "recovering";
      session: SessionId;
      drop: UniplsDrop;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>;

interface Unipls {
  readonly lifecycle: UniplsLifecycleSnapshot;
  on(
    event: "lifecycle",
    listener: (event: {
      previous: UniplsLifecycleSnapshot;
      current: UniplsLifecycleSnapshot;
    }) => void,
  ): () => void;
}
```

理由:

- `state: "closed"` と `intent: "open"` のような、意味の解釈が必要な組み合わせを public type から排除できる。
- phase の絞り込みによって、その状態で利用可能な session/connection/recovery 情報を型安全に参照できる。
- getter と change event の組み合わせは、命令的な参照と reactive な監視の両方を満たし、external store としても利用できる。
- immutable value だけを境界にすることで、利用者や extension が内部 lifecycle を書き換えられない。

実装上の帰結:

- lifecycle coordinator だけが snapshot を生成・更新できるようにする。
- public event の dispatch 時点で `unipls.lifecycle === event.current` が成立するようにする。
- snapshot の object identity、runtime freeze、phase narrowing、event の previous/current を contract test する。
- low-level lifecycle の型と遷移は `unipls/socket` の独立した public contract として test する。

影響するタスク: 3、4、5、6、12。

### D3: 初回 `open()` の失敗と自動回復（決定済み）

決定:

- 初回接続と、いったん ready になった後の再接続に、同じ connection attempt model と reconnector policy を使用する。
- WebSocket 接続拒否、connection timeout、provisioning failure はすべて attempt failure として reconnector policy へ渡す。ライブラリが provisioning failure を一律に recoverable/terminal と決めない。
- reconnector がない場合、初回 attempt の失敗で `open()` を reject する。
- reconnector がある場合、policy が再試行を選ぶ間は `open()` を pending のまま保つ。
- `open()` は、論理 session で最初の connection が provisioning を終えて ready になった時点で resolve する。
- policy が cancel/exhaust を選んだ場合、`open()` は最後の attempt failure を原因として reject する。
- `open()` の待機中に session が明示的に close/abort された場合も reject し、以後の attempt を開始しない。
- policy context には、論理 session が一度も ready になっていない `initial` 由来か、ready 後の drop を回復する `recovery` 由来かを渡す。
- policy context には失敗段階 `connecting` / `provisioning`、attempt 番号、原因、履歴を渡す。これにより「初回だけ再試行しない」「認証エラーは terminal」といった判断を policy 側で表現できる。

公開形の概略:

```ts
interface ConnectionAttemptContext {
  origin: "initial" | "recovery";
  stage: "connecting" | "provisioning";
  attempt: number;
  cause: unknown;
}
```

理由:

- 起動時の一時的な offline と、接続後の一時的な offline を別の再試行実装に分けずに済む。
- 最初の失敗で `open()` だけを reject し、その後 background で接続が成功するという驚きのある状態を避けられる。
- provisioning failure の中には一時障害と認証失敗の両方があるため、library core より application policy の方が正しく分類できる。

実装上の帰結:

- initial/recovery の違いは別 engine ではなく attempt context の入力として表す。
- `open()` の Promise と recovery engine の lifecycle を同じ session coordinator が所有する。
- 各 attempt の timeout と、複数 attempt を含む `open()` 全体の待機を混同しない。全体を断念する条件は policy または明示的な close/abort が決める。
- initial attempt の connection/provisioning failure、retry success、cancel/exhaust、close/abort を contract test する。

影響するタスク: 3、6。

### D4: recovery を断念した後の session（決定済み）

決定:

- reconnector の `cancel` または試行上限到達による exhaustion は、recovery cycle だけでなく現在の論理 session の terminal outcome とする。
- reconnector が再試行時機を待っている間は `recovering` phase とし、同じ session、session-scoped resource、回復継続を選んだ operation を維持する。
- 後から同じ session を回復する可能性がある policy は、待機中に `cancel` せず、online event や利用者操作を待ってから `reconnect` action を呼ぶ。
- `cancel` / exhaustion 後に同じ session を再開する `resume` API は設けない。
- terminal outcome では session の AbortSignal を abort し、connection/session-scoped resource、timer、listener、pending reconnect action をすべて破棄する。
- 待機中のoperationは、D11で確定した`UniplsDroppedError`で一度だけsettleする。error/finalization metadataは`recovery-cancelled`、`recovery-exhausted`、`reconnector-failed`を区別し、canonical dropと最後の原因を保持する。
- lifecycle は terminal `dropped` の active session を残さず、`closed` phase へ遷移する。`closed` snapshot は user close と recovery failure を `reason` で区別する。
- terminal outcome 後の `open()` は新しい session ID と新しい operation/resource scope を作る。古い operation、provisioning、reconnect action は復活させない。

公開形の概略:

```ts
type ClosedLifecycleSnapshot =
  | Readonly<{
      phase: "closed";
      reason: "idle" | "user";
    }>
  | Readonly<{
      phase: "closed";
      reason: "dropped";
      session: SessionId;
      outcome:
        | "recovery-cancelled"
        | "recovery-exhausted"
        | "reconnector-failed";
      drop: UniplsDrop;
      cause?: unknown;
    }>;
```

理由:

- 接続予定がない session に resource と未完了 operation だけが残る状態をなくせる。
- `open()` を常に「新しい論理 session の開始」という一つの意味に保てる。
- 既存 operation を再開時に復活・再送するかという追加の曖昧さを作らない。
- `cancel` が明確な terminal action になり、policy の待機と断念を区別できる。

実装上の帰結:

- `recovering`からはretryによる`connecting`と、cancel/exhaustion/reconnector failureによる`closed(reason: "dropped")`だけへ遷移する。
- session cleanup と operation termination を、recovery outcome の確定と同じ atomic な遷移で行う。
- cancel/exhaustion 後の遅延 action、古い event、provisioning 完了をtransport epoch/session tokenで無効化する。
- terminal outcome 後に `open()` すると新しい session ID になることを contract test する。

影響するタスク: 5、6、8、9。

### D5: server close の分類（決定済み）

決定:

- 利用者が `close()` を開始した場合だけ user-initiated close とする。
- open intent 中の peer/server 主導 close は、close code `1000` と `wasClean === true` を含め、すべて drop とする。
- core は close code を recoverable/terminal に分類しない。code、reason、`wasClean` を正規化した metadata として reconnector policy へ渡し、application/protocol 固有の判断を委ねる。
- peer close、transport error、timeout、drop detector、明示的な manual drop を、canonical な immutable `UniplsDrop` record に正規化する。
- 同じ `UniplsDrop` を reconnector context、`recovering` lifecycle snapshot、`UniplsDroppedError`、診断 event から参照できるようにする。
- 生の `CloseEvent`、WebSocket object、mutable な内部 session/connection object は公開しない。
- server 由来の close reason は診断 metadata として保持するが、信頼済みのメッセージや domain error code として扱わない。
- drop detectorは任意の明示的な`name`と、`Unipls`への登録順から割り当てられる0始まりの`registrationIndex`で識別する。明示nameは同じ`Unipls` instance内で一意とし、JavaScriptの不安定な`constructor.name`には依存しない。
- detector由来のdropでは`ctx.drop()`を呼んだdetectorのidentityをcanonicalな`UniplsDrop`へ記録する。複数detectorが同じepochについて報告した場合は、最初にdrop settle gateを通過したdetectorだけをcanonical sourceとする。

公開形の概略:

```ts
interface DropDetectorIdentity {
  readonly registrationIndex: number;
  readonly name?: string;
}

type UniplsDropSource =
  | Readonly<{ type: "peer-close" }>
  | Readonly<{ type: "transport-error" }>
  | Readonly<{ type: "timeout" }>
  | Readonly<{
      type: "detector";
      detector: DropDetectorIdentity;
    }>
  | Readonly<{ type: "manual-drop" }>;

interface UniplsDrop {
  readonly source: UniplsDropSource;
  readonly session: SessionId;
  readonly connection: ConnectionId;
  readonly detectedAt: number;
  readonly close?: Readonly<{
    code: number;
    reason: string;
    wasClean: boolean;
  }>;
  readonly cause?: unknown;
}
```

理由:

- close code 1000 は wire protocol 上の正常closeを示すだけで、clientの「接続を維持する」という意図が満たされたことまでは示さない。
- reconnector の判断、lifecycle の表示、operation error の原因を同じdropへ結び付けられる。
- heartbeat timeout やoffline検知もpeer closeと同じ recovery pipelineに載せられる。
- protocol固有のclose codeをcoreへ組み込まずに済む。

実装上の帰結:

- dropを観測した箇所で一度だけ`UniplsDrop`を生成し、record本体とネストしたclose metadataをruntimeでもfreezeする。`cause`はopaque valueとして扱う。
- user close と drop の競合ではsession coordinatorが確定済みintentを見て一度だけ分類する。
- socket close/error、timeout、manual drop、すべてのdetectorの`ctx.drop()`を、transport epoch IDを受け取る単一の同期的な`reportDrop()`相当の入口へ集約する。現在のtransport epochかつ未確定であることの確認と、drop record/stateの確定までに`await`やuser callbackを挟まない。
- dropの勝者を確定した同期区間内でepochを`dropping`へ遷移させ、その後にだけabort、socket close、cleanup、通知、recovery cycle開始を行う。同じepochの後発報告はno-opとし、最初の報告だけがreconnectorを一回起動する。
- detector contextとtransport callbackは作成元transport epoch IDをcaptureする。古いtransport epochの遅延eventは、新しいtransport epochがactiveでもdrop state、operation、recovery cycleを変更しない。
- `recovering` snapshotは単なる`cause: unknown`ではなく`drop: UniplsDrop`を持つ。
- recoveryを行わない、または断念した`UniplsDroppedError`には`drop`とterminal outcomeを保持する。
- public API間で同一dropを追跡できることと、生のtransport objectが漏れないことをcontract testする。

影響するタスク: 5、6、12。

### D6: 切断中および session 外で開始した operation（決定済み）

決定済み:

- 論理 session が active で lifecycle が `recovering` のときに開始した `cast`、`next`、`request`、`listen`、`subscribe` は、即時失敗させず次の ready connection まで待機させる。
- 待機 operation は開始時点の論理 session に束縛し、その session が ready、close、recovery cancel/exhaustion、reconnector failure、timeout、abort のいずれかへ進んだときにだけ次の状態へ進める。
- query/message factory は実際の初回送信時まで評価しない。recovery 待機中に古いtimestamp、token、correlation IDを確定しない。
- recovery中に作られ、まだ一度も送信されていない`cast` / `request` / `subscribe`を次のready connectionで送ることは、retry/resendではなく初回送信として扱う。
- `retry: "fail"`であっても未送信operationはready後に初回送信する。retry policyは一度送信を試みたoperationが、その後dropをまたいだ場合にだけ適用する。
- drop前に送信を試み、peerへ届いたか不明なoperationは未送信operationと区別し、明示的なretry policyなしに再送しない。
- `next` / `listen`はready connectionが得られた後から観測を開始し、D8の決定どおりprovisioning中のmessageを観測しない。
- ready前にrecoveryがcancel/exhaustするかreconnector自体が失敗した場合、payloadを送らず、D4/D11に従ってPromiseをrejectまたはstreamをfinalizeする。
- fail-fastを必要とするcallerはoperationのtimeoutまたは`AbortSignal`を使う。ready必須の別optionは現時点では追加しない。
- operationを開始できるのはactiveなopen intentの内側だけとする。open intentは`open()`呼び出し時に同期的に始まり、明示的な`close()`の呼び出し、初回openのterminal failure、またはrecoveryのcancel/exhaustion/reconnector failureによるterminal outcomeで終わる。
- `connecting`、`provisioning`、`open`、`recovering`はいずれもactive session内なのでoperationを開始できる。まだ`open()`していない状態、`close()`開始後、または`closed(reason: "dropped")`への収束後は開始できない。
- open intent外で`cast`、`next`、`request`、`listen`、`subscribe`を呼ぶことはprogramming errorとし、全operationで同期的に`UniplsInvalidUsageError`をthrowする。Promise系のrejected Promiseやstream系のterminal handleには変換しない。
- active session内で受け付けたoperationが、その後のclose、drop、timeout、abortにより終了する場合はprogramming errorではない。Promiseを非同期にrejectするか、返却済みstream handleをfinalizeする通常のoperation outcomeとして扱う。
- lifecycleの事前確認と直後のoperation呼び出しの間に、通常のJavaScript eventやmicrotaskが割り込むことはない。公開メソッドは同期実行中にoperationをsessionへ登録し、その時点を受付のlinearization pointとする。
- paramsのgetter、message/query factory、extension hookなどのuser codeによる再入を考慮し、受付に必要な入力のsnapshot/validation後、user codeを呼び得る処理より前にactive sessionの最終確認と登録を連続して行う。登録後の再入closeは「受付後の終了」として処理する。

理由:

- active recoveryはsocket不在ではあっても、接続維持を試みている有効な高レベルsessionである。
- readinessのraceと送信待機をclient側へ隠蔽し、利用者がlifecycleを監視してoperationを再生成する必要をなくす。
- 未送信と送達不明を区別することで、利用可能性を保ちながら暗黙の重複送信を避ける。
- open intent外の呼び出しは通信上の失敗ではなくAPI lifecycleの誤用であり、その場で同期的に発見できる。対して、受付後のdropやcloseは通信operationの結果なので非同期の終了経路へ流す。
- terminal状態でrejected Promise/terminal handleを返す案は、API誤用と受付済みoperationの失敗を区別できなくするため採用しない。

実装上の帰結:

- operationは瞬間的なsocket stateではなく、session coordinatorのready/terminal outcomeを待つ。
- session coordinatorに同期的な`acceptOperation`相当の入口を設け、active sessionの確認とoperationのsessionへの束縛を一つの同期処理にする。transportへの実送信はその後でもよい。
- QuerySessionは`created`、`sent/attempted`、`settled`を区別し、retry policyを`sent/attempted`以降にだけ適用する。
- factory評価時点、ready待機、retry適用境界、open intent内外の同期throw境界を5 operationのcontract testで固定する。
- 現実装のoperationごとに異なるclosed時の挙動は破壊的変更として統一し、移行時には`open()`前・`close()`後の呼び出しが同期throwになることをrelease noteに明記する。

影響するタスク: 7、8、9。

### D7: timeout の時計（決定済み）

決定:

- timeoutはD6のlinearization pointでoperationが受け付けられた時点から進むwall-clock deadlineとする。ready connection上で実行された時間だけを積算するactive-time方式は採用しない。
- `connecting`、`provisioning`、`recovering`での待機、初回送信後のresponse待機、retry policyが許可した再送待機をすべて同じdeadlineへ含める。接続epochが変わってもtimerをリセットしない。
- timeoutを持つ全operationは共通primitive上で同じ時計と終了規則を使う。deadline到達時は、未送信・送信済み・stream開始済みのどの段階でも一度だけtimeout outcomeへsettle/finalizeし、listener、timer、abort listener、ready待機、retry待機を破棄する。
- 無期限を表す値は`undefined`だけとする。明示されたtimeoutは有限の正数でなければならず、`0`、負数、`NaN`、正負の`Infinity`は同期的な入力エラーとする。
- deadlineの計測にはwall clockの巻き戻りに影響されないmonotonic clockを使う。テストでは実時計を待たず、clock/schedulerを注入して受付からの経過時間を制御する。
- JavaScriptのevent loopが停止してdeadlineを超えた場合、実行再開後に最初にtimeoutを観測した時点で終了させる。既にsettle/finalize済みなら遅れて発火したtimerは何もしない。

理由:

- timeoutを「callerがoperation全体を待てる上限」として解釈でき、接続障害やprovisioningによって予想外に長く滞留しない。
- active-time方式は接続が復旧しない限り実時間上の上限にならず、fail-fastのために別のtimerをcallerへ要求してしまう。
- epochやretryごとにtimerを作り直さないことで、一つのoperationに一つのdeadlineという単純な所有関係になる。

実装上の帰結:

- operation共通primitiveは受付時のmonotonic deadlineを保持し、各phaseの残り時間ではなく絶対deadlineを参照する。
- timeout validationは全operationの共通入力処理で同期的に行い、operation固有の非同期errorへ変換しない。
- timeoutとresponse、abort、closeなどが同じevent-loop turnで競合しても、共通settle gateを最初に通過したoutcomeだけを採用し、cleanupと通知をexactly onceにする。
- 後から待機中に停止するdeadlineが必要になった場合は、既存timeoutの意味を変更せず別の明示的policyとして追加する。
- timeoutの不正値を黙って無期限または即時timeoutとして扱っている既存経路があれば破壊的変更になるため、移行メモへ記載する。

影響するタスク: 7、8、9、13。

### D8: receive-only operation と readiness（決定済み）

決定:

- 通常の`next` / `listen`にも送信operationと同じreadiness barrierを適用する。`connecting`、`provisioning`、`recovering`で開始したreceive operationはactive sessionへ受け付けるが、次のready connectionが得られるまでmessageの観測を開始しない。
- provisioning中にtransportから届いたmessageは通常の`next` / `listen`へbuffer、replay、fan-outしない。通常operationのselectorやuser callbackも呼ばない。
- provisioning protocolがmessageを受け取る必要がある場合は、provisioning contextが持つreadiness-bypass receive capabilityを使う。このcapabilityから作られたoperationは作成時のtransport epochに束縛し、dropをまたいで次のtransport epochへ移さない。
- 一時的なprovisioning receive operationはprovisioning完了またはepoch終了までにsettleしなければ終了させる。ready後も必要なlistener/resourceはD9の`ResourceScope`へ登録し、session/connectionのどちらに所有させたかに応じた終了時点で破棄する。
- readyへの遷移を受信境界とする。message deliveryがready遷移より前に処理されたmessageはprovisioning側だけ、遷移後に処理されたmessageは通常operation側で観測可能とし、一つのmessageをbarrierの両側へ重複配送しない。
- drop時、通常の継続可能なreceive/stream operationは観測を停止する。次epochのprovisioning messageを無視し、そのepochがreadyになった後にだけ観測を再開する。継続可否と最終的なretry/finalizationはD10/D11の契約に従う。

理由:

- readyを「application operationを安全に開始できる」という送受信共通の保証にできる。受信だけbarrierを迂回すると、認証・同期前のprotocol messageがapplicationへ漏れる。
- provisioning用trafficとapplication trafficのconsumerをcapabilityで分離することで、selectorの偶然の一致や接続epochをまたぐlistenerの残留を防げる。
- provisioning messageを暗黙にbufferすると、古い認証challengeや同期messageがready後にapplication messageとして再解釈され得るため採用しない。

実装上の帰結:

- session coordinatorは通常operation用のready-gated受信経路と、provisioning context用のtransport-epoch-bound受信経路を分ける。生のsocket event busを通常operationへ直接公開しない。
- ready遷移、通常listenerの有効化、provisioning用の一時receive operationの失効を同じcoordinatorで順序付ける。
- `next` / `listen`のtimeoutはD7どおり受付から進み、readiness待機中も停止しない。
- 初回provisioning、recovery後の再provisioning、provisioning失敗、ready境界直前直後のmessageについてcontract testを作り、通常selectorがprovisioning messageに対して評価されないことも検証する。
- 現実装で通常listenerがprovisioning messageを観測できる場合は破壊的変更として移行メモへ記載し、protocol初期化処理をprovisioning contextへ移すよう案内する。

影響するタスク: 7、8、9、10。

### D9: provisioning が登録する資源の所有期間（決定済み）

決定:

- provisionerのAPIを、logical sessionごとに一度だけ成功させるsession setup hookと、transport epochごとに実行するconnection setup hookへ分ける。`isSessionBeginning`を見て一つのhook内で分岐させる方式は廃止する。
- session setupが所有するlistener/subscription/resourceは論理sessionへ束縛し、明示closeまたはD4のterminal dropで破棄する。一時的なdropだけでは破棄・再登録しない。
- connection setupが所有するresourceは作成時のtransport epochへ束縛し、そのtransport epochのloss、provisioning failure、交代、またはsession closeで破棄する。次のtransport epochのconnection setupが新しいresourceを作る。
- setup contextは現在のscopeへdisposerを即時登録する`defer`相当のAPIを持つ。hookの正常終了時に返されたdisposerも同じscopeが所有する。これによりsetup途中で後続処理がthrow/rejectしても、それ以前に登録したresourceをrollbackできる。
- disposerは冪等に扱い、登録と逆順のLIFOで一度だけ実行する。同期・非同期disposerを扱えるようにし、非同期cleanupも順番を保って完了を待つ。
- LIFO stackというresource ownership modelは維持するが、標準の`DisposableStack`/`AsyncDisposableStack`をpublic contractや必須実装にはしない。library専用の`ResourceScope`が任意の識別nameと登録元、async cleanup、個別診断、冪等性、scopeの親子関係を所有する。
- `ResourceScope.dispose()`は最初の呼び出しでcleanupを開始し、競合する後続呼び出しには同じ完了Promiseを返す。dispose開始後の新規登録は`UniplsInvalidUsageError`とし、実行中にdisposerがscopeを延命・追加できないようにする。
- disposerはLIFO順に逐次`await`し、各failureを個別に捕捉して後続cleanupを継続する。標準stack由来の`SuppressedError`や`AggregateError`をscope外へ流さず、D11のdiagnosticへ変換する。
- transport epochを先に無効化して新しいoperation/eventを拒否してから、そのtransport epochのdisposerを実行する。cleanup中に古いcapabilityから新たな通信を開始できないようにする。
- initial attemptではsession setupを成功させた後にconnection setupを成功させて初めてreadyとする。session setupが完了する前にinitial provisioning attemptが失敗した場合は部分resourceをrollbackし、retryするattemptではsession setupを改めて実行する。一度成功したsession setupは同じ論理sessionの再接続では再実行しない。
- session setup contextはsession-scopedでready-gatedなresource登録を担い、connection setup contextだけがD1/D8のtransport-epoch-bound readiness-bypass capabilityを持つ。接続ごとに必要な認証、handshake、購読復元はconnection setupへ置く。

公開形の方向性:

```ts
type MaybePromise<T> = T | PromiseLike<T>;
type Disposer = () => MaybePromise<void>;

interface UniplsProvisioner {
  setupSession?(context: SessionSetupContext): MaybePromise<void | Disposer>;
  setupConnection(context: ConnectionSetupContext): MaybePromise<void | Disposer>;
}

interface ResourceScope {
  defer(disposer: Disposer, options?: { readonly name?: string }): void;
}
```

正確な命名は実装時にpublic type全体と揃えるが、二つのscopeを型とhookで区別すること、`defer`と戻り値のownershipは変更しない。単一functionのshorthandを互換性のため残す場合は、connection setupとして解釈する。

理由:

- `isSessionBeginning`はresourceの所有期間を表さず、条件分岐を忘れるだけで再接続ごとの重複登録を起こす。hook自体の実行回数でscopeを表す方が誤用しにくい。
- hookの戻り値だけでは、setup途中に確保してから最終return前に失敗したresourceを回収できない。即時登録とscope-owned stackがtransactional setupに必要になる。
- session resourceとconnection resourceの終了条件を分けることで、再接続時の重複と、古いepochに束縛されたresourceの残留を同時に防げる。

実装上の帰結:

- session coordinatorはsession scopeを一つ、transport epochごとにconnection scopeを一つ所有し、子scopeであるconnection scopeをsession scopeより先に破棄する。
- setupはtransactionとして実行し、失敗時はそのsetupで新規登録されたdisposerだけをLIFO rollbackする。cleanup errorが後続cleanupを止めないよう全disposerを試行し、D11の診断経路へ集約する。
- setup transaction、detector、operationはそれぞれ適切な親scopeに属する子`ResourceScope`を持ち、rollbackでは対象子scopeだけをdisposeする。単一のglobal stackへcheckpoint indexを混在させない。
- runtimeが標準`AsyncDisposableStack`を十分にsupportする場合も、採用は`ResourceScope`内部の交換可能な実装詳細に限定し、公開挙動やerror modelを標準stackの既定throw semanticsへ依存させない。
- session setup成功済みという事実を論理session stateに保持し、物理connection IDのSetから推測しない。
- `isSessionBeginning`の削除、function shorthandの意味、disposer ownershipをmigration noteへ記載する。
- 初回成功、session setup途中失敗、connection setup途中失敗、recovery後の再setup、close/loss競合、async disposer errorをclock/event制御下でtestする。

影響するタスク: 4、10、11。

### D10: stream API と callback error（決定済み）

決定:

- `listen` / `subscribe`は共通のstream lifecycleを使い、利用者が`next` callbackを渡したかどうかでdelivery adapterを選ぶoverloadにする。`delivery: { type: ... }`のような内部都合の指定は要求しない。
- `next`を渡した場合は同期push型のcallback subscriptionとし、冪等な`unsubscribe()`と`closed: Promise<StreamFinalization>`を持つfirst-class handleを返す。裸のunsubscribe関数だけを返す現行形はcore contractにしない。
- callbackの戻り値は待たず、非同期処理の逐次性や完了順を保証しない。同期throwは捕捉してD11の診断へ通知し、既定ではsubscriptionと他consumerへのfan-outを継続する。throw時に当該subscriptionを終了したい場合だけ`callbackError: "unsubscribe"`を明示する。
- `next`を渡さない場合は、同じhandleに`AsyncIterable<T>`を加えたsingle-consumerの`AsyncSubscription<T>`を返す。`for await`はmessageを一件ずつ取り出すためloop bodyで`await`した処理は逐次になるが、その間もtransportから届くmessageはlocal bufferへ蓄積される。
- AsyncIterable adapterはoperation開始時に同時に作成し、後付け変換までのmessage lossを生じさせない。二つ目のiterator取得は誤用として拒否し、複数consumerが必要ならbroadcast semanticsに従ってsubscriptionを複数作る。
- AsyncIterable bufferは無制限にしない。通常はdocumentされた有限の既定capacityとoverflow時errorを使い、`buffer: number`、`buffer: "latest"`、または`{ capacity, overflow: "error" | "drop-oldest" | "drop-newest" }`で上書きできる。drop policyによるmessage lossは診断へ通知する。
- `buffer: number`は指定capacityと`overflow: "error"`のshorthand、`buffer: "latest"`はcapacity 1と`overflow: "drop-oldest"`のshorthandとして扱う。`undefined`はTask 9で固定する既定capacityと`overflow: "error"`を使う。
- WebSocket peerに対するbackpressureは保証しない。bufferはlibrary内のconsumer速度差を吸収するだけであり、peerの送信速度を制御しない。
- iteratorの`break` / `return()`は`unsubscribe()`へ写像し、buffer済みの未処理messageを破棄する。明示的な`unsubscribe()`もlocal observation、未送信query、listener/timerを終了するが、generic protocol上のremote unsubscribe message送信までは意味しない。
- terminatorはyieldせずiterationを正常終了し、finalizationの`terminated` variantにterminator messageを保持する。明示closeとunsubscribeも正常終了とし、timeout、terminal drop、abort、buffer overflow、fatal operation errorはiterationをthrowさせる。recovery成功時は終了せず次のready後に継続する。
- streamでは各messageについてterminatorをselectorより先に評価する。terminatorがtrueならselector/callback/yieldへ渡さず`terminated`へ進み、falseのときだけ通常selectorを評価する。terminatorがthrowした場合も同じoperationでは通常selectorへ渡さない。
- `closed`は失敗時にもrejectせず、内部状態をterminalにしてlistener、timer、abort hook、bufferなどのcleanupが完了した後、frozenな終了理由のdiscriminated unionを一度だけresolveする。handleを監視しないcallerにもunhandled rejectionを発生させない。
- 現行の`onTerminated`、`onFatalError`、`onUnsubscribed`、`finally`はAsyncIterable APIに持ち込まない。yield、iterationの正常終了/throw、`try/finally`、canonicalな`closed` resultで置き換える。互換callback adapterを残す場合も`closed`から一方向に通知し、終了状態を二重実装しない。

公開形の方向性:

```ts
interface SubscriptionHandle<TFinalization = StreamFinalization> {
  unsubscribe(): void;
  readonly closed: Promise<TFinalization>;
}

interface AsyncSubscription<T, TFinalization = StreamFinalization<T>>
  extends AsyncIterable<T>, SubscriptionHandle<TFinalization> {}

const callbackSubscription = unipls.listen({
  selector,
  next(message) {
    updateState(message);
  },
  callbackError: "continue", // default
});

const messages = unipls.listen({ selector, buffer: 64 });
for await (const message of messages) {
  await process(message);
}

const subscription = unipls.subscribe({ query, selector, terminator });
for await (const message of subscription) {
  await process(message);
}

const finalization = await subscription.closed;
if (finalization.ok && finalization.reason === "terminated") {
  consumeTerminalMessage(finalization.message);
}
```

D11の`StreamFinalization` unionを正本とする。terminatorに一致したmessageは通常messageとしてyieldせず、cleanup後にresolveする`closed`の`terminated` variantだけに保持する。

理由:

- messageというdata planeは軽量なcallbackまたは逐次的なAsyncIterableから選べ、unsubscribeと終了理由というcontrol planeは同じhandleへ集約できる。
- 同期throwなら終了し、async callbackのrejectなら継続する契約は不自然である。callback modeを明確な非逐次observerとし、継続/終了policyを明示することで差を解消する。
- 現行のunsubscribe関数からは終了済みか、cleanupが完了したか、なぜ終了したかを確認できず、consumerやtestがcallbackを独自にPromise化している。
- lifecycle callback群をAsyncIterableへ移植するより、言語標準のiteration制御とcanonicalなfinalizationを使う方が終了経路を一つに保てる。
- `cancel`はremote処理の取消まで含む広い意味に読める。実際の副作用はlocal observationと関連resourceの終了なので`unsubscribe`が正確である。

実装上の帰結:

- 共通stream scopeがhandle、settle gate、finalization snapshot、cleanup stackを所有し、callback/AsyncIterableをその上のdelivery adapterとして実装する。
- callback throwはevent busへ再throwせず、診断後にpolicyが`unsubscribe`の場合だけ共通finalizeへ流す。callbackが返すPromiseは観測しないことを型・API doc・testで明示する。
- AsyncIterable adapterは有限queueとpending `next()`を所有し、overflow、iterator `return()`、外部unsubscribe、operation終了の競合をexactly onceで処理する。
- 互換目的でlegacy終了callback adapterを明示的に残す場合、そのcallbackの例外はcanonical finalizationを変更せず診断だけへ流す。
- `() => void`を返す現行APIは破壊的変更になる。移行例として`const stop = () => subscription.unsubscribe()`を示す。disposerを要求するframeworkにはこの明示的adapterを使い、D12の決定により`Symbol.dispose`は初期public contractへ追加しない。
- callback継続/明示unsubscribe、async callbackの非逐次性、single-consumer、既定/各overflow policy、break、terminator、全failure、cleanupと`closed`の順序をcontract testする。

影響するタスク: 7、9、12、13。

### D11: error と診断の公開モデル（決定済み）

決定済み:

- APIの呼び出し順序やlifecycleに反する利用は、内部stateではなく利用者の誤用を表す`UniplsInvalidUsageError`とする。open intent外のoperation、二重`open()`、二つ目のAsyncIterator取得、失効したprovisioning capabilityの利用が該当する。
- wrong typeや必須値欠落は`TypeError`、timeoutやbuffer capacityなど数値範囲の不正は`RangeError`とし、`UniplsInvalidUsageError`へ混ぜない。
- 初回論理sessionが一度もreadyになれずterminalになった場合は`UniplsOpenError`とする。`outcome: "attempt-failed" | "attempts-cancelled" | "attempts-exhausted" | "reconnector-failed"`、attempt/history情報、最後の`cause`を持ち、peer closeを伴う場合はcanonicalな`drop`も保持できる。単一のattemptに帰属しないreconnector failureへ無理にstageを付けない。
- 一度readyになったsession/operationがdropによって継続不能になった場合は`UniplsDroppedError`とする。`outcome: "operation-failed" | "recovery-cancelled" | "recovery-exhausted" | "reconnector-failed"`、canonicalな`drop: UniplsDrop`、最後の`cause`を持つ。
- 利用者の明示的な`close()`によって受付済みoperationが終了した場合だけ`UniplsClosedError`とする。open intent外の誤用やpeer/server closeには使わない。
- deadline到達は`UniplsTimeoutError`、AsyncIterableのoverflow policy `"error"`による終了は`UniplsBufferOverflowError`とする。
- `AbortSignal`による終了は新しいwrapperを作らず`signal.reason`を使用する。query/message factoryとserializerのようにoperationの処理自体を続行不能にするuser codeのthrowは、元の値をoperation result/fatal finalizationに保持する。
- provisionerのthrowは接続をreadyにできないlifecycle failureなので、生のまま`open()`から投げず、initialでは`UniplsOpenError`、ready後のrecovery断念では`UniplsDroppedError`の`cause`に保持する。reconnector policyには分類前の元のcauseとstageを渡す。
- 高レベルrootの安定したdomain errorは`UniplsInvalidUsageError`、`UniplsOpenError`、`UniplsClosedError`、`UniplsDroppedError`、`UniplsTimeoutError`、`UniplsBufferOverflowError`に限定する。transport固有errorは`unipls/socket`だけから公開する。
- 全domain errorは安定した`name`を持ち、公開metadataはreadonlyかつruntimeでもfreezeする。生の`CloseEvent`、socket、mutable内部stateは保持しない。
- deserializerが単一messageでthrowした場合、そのmessageだけを破棄してactive operationは継続する。現行の汎用`error` eventのように全operationへbroadcastしてreject/finalizeさせない。
- deserialization failureは有限で型付けされたpublic `diagnostic` eventの`message-deserialization-failed` variantで通知する。これはselectorによるroutingより前の失敗なので特定operationへ帰属させず、connection-scoped diagnosticとする。
- deserialization diagnosticはsession ID、connection ID、connection内のmessage sequence、発生時刻、opaqueな`cause`、raw inputのkind/sizeだけを持つ。credential漏洩、巨大payload保持、mutable binary露出を避けるためraw message本体を既定payloadへ含めない。
- diagnostic wrapperとmetadataはruntimeでもfreezeする。opaqueな`cause`自体のdeep freezeやcloneは行わない。
- message破棄と内部処理を確定した後のmicrotaskでdiagnosticをdispatchする。listenerのthrowは他listener、operation、connection lifecycleから隔離し、diagnostic listener errorについて同じeventを再帰的に発行しない。
- diagnostic listenerがない場合にlibraryが`console.warn`しない。fatalと判断するapplicationはdiagnostic handlerから明示的にdrop/closeする。
- diagnostic scopeは`session`、`connection`、`operation`を判別できるunionにする。selectorより後に発生して所有operationが一意なdiagnosticだけがopaqueなoperation ID/typeを持てる。deserialization failureにactive operation一覧や推測したoperation IDを付けない。
- selectorまたはterminatorが単一messageでthrowした場合、そのmessageを該当operationについてだけ破棄し、元のerrorを持つoperation-scoped diagnosticを通知する。他operationへの同じmessageのfan-outは継続する。
- predicate errorの既定policyは`"continue"`とし、該当operationは後続messageの観測を続ける。fail-fastが必要なcallerだけ`predicateError: "fail"`を明示する。
- `predicateError: "fail"`では`next` / `request`を元のerrorでrejectし、callback streamを`fatal-error`でfinalizeし、AsyncIterableを元のerrorでthrowさせる。新しいwrapper error classは作らない。
- terminatorの評価がthrowしたmessageは、終端か通常messageかを安全に判定できないため、同じoperationの通常selectorへ渡さずyield/callbackもしない。
- selector/terminatorのthrowはoperation-scopedな`message-predicate-failed` diagnosticとして通知する。severityはoperationの継続可否ではなくuser predicateの実行失敗を表す`"error"`とし、`cause`、`predicate: "selector" | "terminator"`、適用した`predicateError` policyを保持する。
- predicate diagnosticにmessage本体、connection ID、message sequenceを含めない。connectionとsequenceから入力を取得できる公開trace storeは存在せず、相関キーだけを公開しても入力を追跡できないためである。必要な利用者はpredicate内で安全な範囲の入力情報を記録する。
- reconnectorの`setup`またはpolicy処理がthrow/rejectした場合、retryを継続する主体が壊れているため無期限待機や暗黙retryへ戻さず、現在の論理sessionをterminalにする。
- initial open中のreconnector failureは`UniplsOpenError(outcome: "reconnector-failed")`、ready後のrecovery中は`UniplsDroppedError(outcome: "reconnector-failed")`とし、元のerrorを`cause`に保持する。
- reconnector failureはsession-scopedな`reconnector-failed` diagnosticとしても一度だけ通知する。session/connection resourceをcleanupし、pending operationを同じterminal outcomeで一度だけsettle/finalizeしてから`closed` lifecycleへ遷移する。
- reconnector diagnosticは`context: "initial-open" | "recovery"`と`failurePoint: "setup" | "policy"`を持つ。initialでは`UniplsOpenError`、recoveryでは`UniplsDroppedError`を`error`に保持し、`open()`、pending operation、stream finalizationへ渡すterminal errorと同じinstanceを共有する。元の`cause`も保持し、`cause === error.cause`を保証する。
- reconnectorはconnection attemptの間でも失敗し得るためdiagnosticをconnectionへ帰属させない。attempt/history metadataはcanonicalなterminal errorから参照し、diagnosticへ別形式で複製しない。
- drop detectorのsetupがthrow/rejectした場合は、ready前のconnection setup failureとして扱う。同じsetup transactionで先に登録されたdetector/resourceをLIFO rollbackし、元のerrorを`stage: "provisioning"`のattempt causeとしてreconnector policyへ渡す。
- detector setup failureがinitialでterminalになれば`UniplsOpenError`、ready済みsessionのrecovery attemptでterminalになれば`UniplsDroppedError`のcauseに保持する。detector専用のdomain error classは追加しない。
- setup成功後のdetector runtime callbackがthrow/rejectした場合は、throw自体をdropの根拠にせず、失敗したdetectorだけを現在のtransport epochで停止・disposeする。他detectorとconnection/session lifecycleは継続する。
- detector runtime failureは元のerror、detectorを識別するimmutable metadata、session/connectionを持つconnection-scoped `drop-detector-failed` diagnosticとして通知する。fatalと判断するapplicationだけがhandlerから明示的にdropする。
- detector identityは`registrationIndex`と任意の明示`name`からなり、runtime failure diagnosticと正常検出による`UniplsDrop.source`で同じfrozen recordを共有する。detector object自体や`constructor.name`は公開しない。
- `drop-detector-failed` diagnosticはfailureを捕捉した監督境界を`boundary: "guard" | "run"`で示す。cleanupも失敗した場合は別の`resource-cleanup-failed` diagnosticとして通知する。
- 現行の`setup(ctx): () => void`だけではdetector自身がtimerやhost eventへ登録したcallbackの後発throw/rejectをlibraryから捕捉できないため、detector contextに監督境界を明示する`guard()`と`run()`を設ける。`guard()`はevent callback、`run()`はbackground taskに使用する。
- `guard(callback)`は同じ引数を受け取るvoid callbackを返し、callbackの同期throwと返されたPromiseのrejectを捕捉する。`run(task)`はtaskを開始し、その同期throw/非同期rejectを同じfailure経路へ流す。どちらもfailureを呼出元やhost event loopへ再throwせず、unhandled rejectionを発生させない。
- detector contextはdetector instanceとtransport epochに束縛された`AbortSignal`を持つ。transport epoch終了または当該detectorのruntime failureでsignalをabortし、そのdetector scopeのdisposerをLIFOで一度ずつ実行する。signal abortを理由とするtask終了はruntime failureとして診断しない。
- `guard()`を通さずdetectorがhostへ直接登録したcallbackや、`run()`へ登録しなかったdetached taskのfailureはlibraryの監督外であることを契約に明記する。built-in detectorはすべて監督APIだけを使う。
- disposer/cleanupがthrow/rejectしても残りのdisposerをLIFO順ですべて実行する。各disposerは成功・失敗にかかわらず一度だけ試行済みとし、同じ終了処理や競合する終了経路から再実行しない。
- cleanup failureはsession、connection、operationのterminal outcomeを変更せず、`close()`やsubscriptionの`closed`をrejectさせない。cleanup完了は全disposerの成功ではなく、全disposerを一度ずつ試行し終えたことを意味する。
- setup rollbackでは元のsetup errorをattempt failureの主要なcauseとして維持し、rollback中のcleanup errorで置き換えたり`AggregateError`へ暗黙変換したりしない。
- cleanup failureは元のerror、所有scope、発生時刻、任意のresource name、登録元を持つ`resource-cleanup-failed` diagnosticとして一件ずつ通知する。resource object、disposer function、登録順のindexは公開しない。
- `defer()`で識別が必要なresourceには利用者が任意の`name`を指定でき、指定nameは同じ`ResourceScope`内で一意とする。nameを省略したresourceの個別識別は保証しない。library-owned resourceには診断で意味のある安定したnameを付ける。
- streamのcanonicalな終了結果はliteral booleanの`ok`と`reason`を持つfrozenなdiscriminated unionとする。`ok`は単なる計算済みbooleanではなく、`if (!result.ok)`でfailure variantとその`error`へ型narrowingできる判別子とする。
- terminator一致、利用者の`unsubscribe()`またはiteratorの`return()`、sessionの明示closeは正常終了として`ok: true`にする。terminator一致時だけ終端messageを`message`に保持する。
- abort、timeout、initial open failure、terminal drop、buffer overflow、callback error policyによる終了、その他のoperation固有fatal errorは`ok: false`とし、AsyncIteratorまたは対応するPromiseがthrow/rejectする値と同じ値を`error`に保持する。
- `callbackError: "unsubscribe"`による終了は利用者自身のunsubscribeと区別して`reason: "callback-error"`とする。cleanup failureはdiagnosticだけで通知し、本来のstream finalizationの`ok`、`reason`、`error`を変更しない。
- callbackの同期throwはoperation-scopedな`stream-callback-failed` diagnosticとして通知する。severityはstreamの継続可否ではなくuser callbackの実行失敗を表す`"error"`とし、`cause`と適用した`callbackError` policyを保持する。
- callbackが返すPromiseは待機も観測もしないため、その非同期rejectをlibraryのdiagnosticへ変換しない。diagnosticにcallbackへ渡したmessage本体は含めない。
- callback failureのpolicy適用と内部状態の確定後にdiagnosticを通知する。`callbackError: "unsubscribe"`でも、callback自身のreentrantな`unsubscribe()`などが先にsettle gateを通過していれば、すでに確定したfinalizationを`callback-error`へ変更しない。
- AsyncIterableのbuffer strategyが`"latest"`、`"drop-oldest"`、`"drop-newest"`のときは、破棄したmessageごとにoperation-scopedな`stream-message-dropped` diagnosticを一件通知する。severityは意図的に選択されたlossy policyによる損失を表す`"warning"`とする。
- buffer drop diagnosticは正確な損失件数を数えられるよう内部で時間集約せず、正規化前のstrategyと実効capacityを持つ。message本体は保持せず、diagnostic listenerがなければsnapshot生成とdispatchを省略し、libraryからconsole出力しない。
- overflow policy `"error"`は`UniplsBufferOverflowError`、AsyncIteratorのthrow、stream finalizationで直接観測できるため、`stream-message-dropped` diagnosticを重複通知しない。

公開形の方向性:

```ts
type UniplsOpenErrorOutcome =
  | "attempt-failed"
  | "attempts-cancelled"
  | "attempts-exhausted"
  | "reconnector-failed";

class UniplsOpenError extends UniplsError {
  readonly outcome: UniplsOpenErrorOutcome;
  readonly stage?: "connecting" | "provisioning";
  readonly attempts: readonly ConnectionAttemptSnapshot[];
  readonly cause: unknown;
  readonly drop?: UniplsDrop;
}

type UniplsDroppedErrorOutcome =
  | "operation-failed"
  | "recovery-cancelled"
  | "recovery-exhausted"
  | "reconnector-failed";

class UniplsDroppedError extends UniplsError {
  readonly outcome: UniplsDroppedErrorOutcome;
  readonly drop: UniplsDrop;
  readonly attempts: readonly ConnectionAttemptSnapshot[];
  readonly cause?: unknown;
}

type UniplsDiagnosticScope =
  | Readonly<{
      type: "session";
      session: SessionId;
    }>
  | Readonly<{
      type: "connection";
      session: SessionId;
      connection: ConnectionId;
      messageSequence?: number;
    }>
  | Readonly<{
      type: "operation";
      session: SessionId;
      operation: OperationId;
      operationType: "cast" | "next" | "request" | "listen" | "subscribe";
    }>;

type MessageDeserializationFailedDiagnostic = Readonly<{
  type: "message-deserialization-failed";
  severity: "warning";
  scope: Extract<UniplsDiagnosticScope, { type: "connection" }>;
  occurredAt: number;
  cause: unknown;
  input: Readonly<{
    kind: "text" | "array-buffer" | "typed-array" | "blob";
    size?: number;
  }>;
}>;

type PredicateErrorPolicy = "continue" | "fail";

type StreamFinalization<T> =
  | Readonly<{ ok: true; reason: "terminated"; message: T }>
  | Readonly<{ ok: true; reason: "unsubscribed" }>
  | Readonly<{ ok: true; reason: "closed" }>
  | Readonly<{ ok: false; reason: "aborted"; error: unknown }>
  | Readonly<{
      ok: false;
      reason: "timeout";
      error: UniplsTimeoutError;
    }>
  | Readonly<{
      ok: false;
      reason: "open-error";
      error: UniplsOpenError;
    }>
  | Readonly<{
      ok: false;
      reason: "dropped";
      error: UniplsDroppedError;
    }>
  | Readonly<{
      ok: false;
      reason: "buffer-overflow";
      error: UniplsBufferOverflowError;
    }>
  | Readonly<{ ok: false; reason: "callback-error"; error: unknown }>
  | Readonly<{ ok: false; reason: "fatal-error"; error: unknown }>;

type StreamCallbackFailedDiagnostic = Readonly<{
  type: "stream-callback-failed";
  severity: "error";
  scope: Extract<UniplsDiagnosticScope, { type: "operation" }>;
  occurredAt: number;
  cause: unknown;
  policy: "continue" | "unsubscribe";
}>;

type MessagePredicateFailedDiagnostic = Readonly<{
  type: "message-predicate-failed";
  severity: "error";
  scope: Extract<UniplsDiagnosticScope, { type: "operation" }>;
  occurredAt: number;
  cause: unknown;
  predicate: "selector" | "terminator";
  policy: PredicateErrorPolicy;
}>;

type StreamMessageDroppedDiagnostic = Readonly<{
  type: "stream-message-dropped";
  severity: "warning";
  scope: Extract<UniplsDiagnosticScope, { type: "operation" }>;
  occurredAt: number;
  strategy: "latest" | "drop-oldest" | "drop-newest";
  capacity: number;
}>;

type ReconnectorFailedDiagnostic =
  | Readonly<{
      type: "reconnector-failed";
      severity: "error";
      scope: Extract<UniplsDiagnosticScope, { type: "session" }>;
      occurredAt: number;
      context: "initial-open";
      failurePoint: "setup" | "policy";
      cause: unknown;
      error: UniplsOpenError;
    }>
  | Readonly<{
      type: "reconnector-failed";
      severity: "error";
      scope: Extract<UniplsDiagnosticScope, { type: "session" }>;
      occurredAt: number;
      context: "recovery";
      failurePoint: "setup" | "policy";
      cause: unknown;
      error: UniplsDroppedError;
    }>;

type DropDetectorFailedDiagnostic = Readonly<{
  type: "drop-detector-failed";
  severity: "error";
  scope: Extract<UniplsDiagnosticScope, { type: "connection" }>;
  occurredAt: number;
  cause: unknown;
  detector: DropDetectorIdentity;
  boundary: "guard" | "run";
}>;

type ResourceCleanupFailedDiagnostic = Readonly<{
  type: "resource-cleanup-failed";
  severity: "error";
  scope: UniplsDiagnosticScope;
  occurredAt: number;
  cause: unknown;
  resource: Readonly<{
    name?: string;
    source: "defer" | "setup-return" | "internal";
  }>;
}>;

type UniplsDiagnostic =
  | MessageDeserializationFailedDiagnostic
  | MessagePredicateFailedDiagnostic
  | StreamCallbackFailedDiagnostic
  | StreamMessageDroppedDiagnostic
  | ReconnectorFailedDiagnostic
  | DropDetectorFailedDiagnostic
  | ResourceCleanupFailedDiagnostic;

interface UniplsDropDetector<TInput = unknown, TOutput = unknown> {
  readonly name?: string;
  setup(
    context: DropDetectorContext<TInput, TOutput>,
  ): MaybePromise<void | Disposer>;
}

interface DropDetectorContext<TInput = unknown, TOutput = unknown>
  extends ResourceScope {
  readonly signal: AbortSignal;
  drop(): void;
  request(
    params: DropDetectorRequestParams<TInput, TOutput>,
  ): Promise<TOutput>;
  guard<TArgs extends unknown[]>(
    callback: (...args: TArgs) => void | Promise<void>,
  ): (...args: TArgs) => void;
  run(task: (signal: AbortSignal) => void | Promise<void>): void;
}
```

正確なattempt/history metadataはD3/D4のimmutable recordと共用し、error内に別形式を作らない。

理由:

- `invalid-state`は内部実装の状態を主語にするが、問題は利用者のAPI lifecycle違反なので`invalid-usage`の方が明快である。
- 異常切断を表す既存の`drop`語彙へ統一し、`connection loss`や`lost`という同義語をpublic contractへ追加しない。
- 初回open失敗はready済みsessionのdropではないため`UniplsDroppedError`へ押し込まず、利用者が呼んだ`open()`に対応する`UniplsOpenError`で表す。
- reconnect policyはraw causeを見てrecoverable/terminalを判断でき、最終callerは安定したlibrary errorと元のcauseの両方を参照できる。

実装上の帰結:

- D5で決めたcanonical record名を`ConnectionLoss`から`UniplsDrop`、参照propertyを`loss`から`drop`へ変更する。分類意味、close code非依存、object identity共有は変えない。
- currentの`UniplsDuplicatedConnectionError`とclosed状態での`UniplsClosedError`同期throwを`UniplsInvalidUsageError`へ統合する。
- currentのmetadataを持たない`UniplsDroppedError`を、canonical dropとoutcomeを持つ形へ置き換える。初回接続/provisioning失敗用に`UniplsOpenError`を追加する。
- domain error classごとに`name`、prototype、`cause`、frozen metadata、ESM packageをまたぐconsumer testを追加する。
- raw message handlerからdeserializer failureをoperation event busへ流す経路を除去し、transport epoch coordinatorがmessage sequenceとdiagnostic snapshotを生成する。
- diagnostic dispatch専用の隔離されたfan-outを実装し、listener throw後も残りlistenerを通知する。library内部の`console.warn`を診断経路に置き換える。
- selector/terminator評価をoperation境界でcatchし、predicate error policyの適用、operation-scoped diagnostic生成、当該messageの破棄を一つの処理にする。
- predicate diagnostic生成時にraw/deserialized messageをsnapshotへ保持せず、実体を取得できないconnection/message sequenceも追加しない。
- reconnector entrypointをtry/catchして元のcauseをsession coordinatorへterminal outcomeとして渡し、session-scoped diagnosticと全pending operationへ同じ結果を伝播する。
- reconnector failureのterminal errorを一度だけ生成し、diagnostic、`open()`、pending operation、stream finalizationで同じobject identityを共有する。diagnostic用にattempt historyを再構築しない。
- detector setupをconnection setup transactionへ組み込み、部分失敗をD9のscope-owned disposer stackでrollbackする。
- detector runtime callbackをerror boundary内で実行し、failure時は当該detectorのdisposerを一度だけ実行してconnection-scoped diagnosticへ変換する。diagnostic通知だけを理由にdropしない。
- detectorごとのsupervisorが`guard()` callbackと`run()` taskを同じsettle gateへ接続する。最初のruntime failureでscopeを無効化・abortしてcleanupを開始し、後発failureやepoch終了との競合で二重診断・二重disposeしない。
- detector登録時にidentityを一度だけfreezeし、detector context、runtime diagnostic、detector由来dropへ同じidentityを渡す。明示nameの重複はsession開始前のconfiguration validationで拒否する。
- scope-owned disposer stackは各disposerの同期throw/非同期rejectを個別にcatchして診断snapshotを作り、後続cleanupを継続する。全試行完了後に元のlifecycle/operation outcomeをsettleする。
- scope-owned stackは専用`ResourceScope`として実装し、dispose Promiseをmemoizeして競合する終了経路を一つのcleanupへ収束させる。標準`DisposableStack`を直接公開・要求しない。
- publicなresource identityを登録順から生成しない。scope内部の順序はLIFO実行だけに使い、diagnostic snapshotには任意の一意nameと登録元だけを渡す。
- stream settle gateは終了原因を一度だけ分類し、cleanup完了後に対応するfrozen finalizationを作る。failure variantの`error`はiterator/Promiseへ渡した値と同じ参照を使い、wrapperの二重生成やcauseの喪失を避ける。
- callback invocationをerror boundaryで囲み、同期throw時はpolicyを共通settle gateへ適用してからfrozenな`stream-callback-failed` snapshotをdiagnostic dispatcherへ渡す。callback戻り値にthenable処理を加えない。
- AsyncIterable queueがlossy overflow policyを適用した地点で一件ずつ診断する。diagnostic listener不在時はdrop処理だけを行い、messageごとのmicrotaskやsnapshotを作らないfast pathを設ける。

影響するタスク: 5、6、7、9、11、12、13。

### D12: 対応 runtime と言語機能（決定済み）

決定済み:

- Browser、Node.js、Deno、Bunを公式対応runtimeとする。WebSocket constructorを注入できることだけを理由にDeno/Bunをbest effort扱いにはしない。
- 公式対応とは、公開する最低versionまたはbrowser policy上の環境でroot APIと`unipls/socket`のimport、型検査、最小接続、close/drop cleanupをCIのconsumer smoke testとして継続検証することを意味する。
- runtime固有globalの差異をcoreへ散在させず、transport注入とplatform別entry pointで隔離する。一つのruntimeだけで動く実装を他runtime向けexportからmodule evaluation時に読み込まない。
- BrowserはChrome、Firefox、Safariの最新2安定版をrolling supportする。Node.jsは`>=22.4.0`、Denoは`>=2.0.0`、Bunは`>=1.2.0`を最低versionとし、JavaScript配布物のtargetはES2022とする。
- CIはversionを固定した各最低runtimeと最新stableの両方を検証する。browserは最新2安定版に相当するChromium、Firefox、WebKit matrixを継続更新する。
- 4 runtimeすべてで`globalThis.WebSocket`を既定transportとするが、module evaluation時には参照せず`Unipls`構築時に解決・検証する。注入されたconstructorがあれば常に優先し、globalも注入もない場合は構成不備として同期的に失敗する。
- WebSocket polyfillや`ws` packageをbundleしない。public declarationはDOMの具象`WebSocket`型へ直接依存せず、`unipls/socket`から必要最小限のstructural transport interfaceを公開する。
- `AbortSignal.any`を4 runtime共通の必須native capabilityとし、user signal、operation/resource scope signal、timeout signalの合成に使用する。library独自polyfillは持たず、最初にabortしたsource signalの`reason`をwrapperなしで伝播する。
- 最低version CIで`AbortSignal.any`の存在だけでなく、入力済みabort signalの優先順位、最初のreasonのobject identity、後発abortで結果が変わらないことをsmoke testする。
- explicit resource managementは初期releaseのpublic contractとruntime前提に含めない。canonicalな終了APIは`await unipls.close()`、subscriptionの`unsubscribe()`と非rejectingな`closed`に限定する。
- public declarationから`Symbol.dispose`/`Symbol.asyncDispose`を除き、配布物、source、consumer codeに`using`/`await using`構文を要求しない。internal componentも通常の明示的な`dispose()`/`disposeAsync()`を使用する。
- 現行の`Unipls[Symbol.asyncDispose]`と`await using`依存testは明示的な`try/finally` cleanupへ移行する。将来4 runtimeのsupport matrix全体で構文・symbol・型libraryを保証できる時点で、既存の終了意味を変えないadapterとして再検討できる。
- root `unipls`はdrop detector interfaceとruntime非依存な`HeartbeatDropDetector`を公開する。browserの`window`/offline eventへ依存する`NetworkDropDetector`はrootから除き、`unipls/browser`から公開する。
- root importからbrowser固有moduleを読み込まず、Node/Deno/Bunで`window`へ触れない。`unipls/browser`を他runtimeから利用した場合の動作は保証しない。
- Node/Deno/Bun固有detectorは実装が存在するときにだけ対応subpathを追加し、予約目的の空entry pointは作らない。`unipls/browser`は将来のbrowser固有adapterも収容できる境界とする。

影響するタスク: 1、11、13、14。

### D13: correlation helper を core release に含めるか（決定済み）

決定:

- 初期releaseのpublic APIにcorrelation helper、key extractor、router optionを追加しない。selectorによるbroadcast semanticsを先に安定させ、計測または実利用の要求が得られるまでTask 15のoptional workとする。
- 一方、現行のように各operationがraw message eventへ直接listenerを登録する構造は廃止し、Task 7でoperation lifecycleとmessage dispatchを内部interfaceに分離する。後付けhelperがtimeout、drop/recovery、cleanupを再実装しなくてよいことを初期releaseの内部設計要件とする。
- defaultは全active operationを候補とする`BroadcastDispatcher`相当とする。将来のkeyed dispatcherはcandidate setを絞るだけで、最終的なselector/terminator評価とoperation lifecycleは共通primitiveを使う。
- 同じkeyを待つ複数operationにはbucket内で従来どおりfan-outし、一つのmessageが複数operationに一致できる性質を維持する。key routingを一対一responseの意味へ暗黙に変更しない。
- dispatcher interfaceとroute hintは初期releaseではinternalに保ち、未確定なpublic extension pointや予約optionを公開しない。将来は既存APIを壊さない追加APIとしてcorrelated view/helperを構築できる形にする。

将来の公開形の例（未決定）:

```ts
const correlated = unipls.correlate({
  key: (message) => message.requestId,
});

await correlated.request({
  key: request.id,
  query: request,
  selector: isExpectedResponse,
});
```

この例の命名、key欠落・抽出失敗・重複keyの契約はTask 15で決め、初期releaseのpublic contractには含めない。

影響するタスク: 7、15。

## Task 0 decision record: 用語、状態遷移、operation contract

この節はD1〜D13を実装とcontract testへ落とす際の正規化済みの語彙とbehavior matrixである。前節の「公開形の概略」「公開形の方向性」と細部が異なる場合は、この節の最終形を優先する。

### 用語とidentity

- **open intent**: 利用者が接続を維持する意図。`open()`の同期区間で開始し、`close()`の同期区間、初回openのterminal failure、またはready後のrecovery terminal outcomeで終了する。open intentがactiveであることと、現在readyな物理接続があることは別である。
- **logical session**: 一回のopen intentに対応する所有scope。session-scoped resource、operation、connection attempt historyを所有する。再接続に成功しても同じsessionであり、terminal outcome後の次の`open()`は必ず新しいsessionを作る。
- **transport epoch**: WebSocket constructorの呼び出しを含む、一回のtransport接続試行に対応する世代。transport epoch IDはattempt開始時、user codeやWebSocket constructorを呼ぶ前に発行する。socket生成に失敗したtransport epochにもIDがある。transport epochは最大一つだけcurrentであり、無効化後のevent、callback、provisioning完了は観測可能な状態を変更できない。
- **connection attempt**: 一つのtransport epochを作り、transport接続とprovisioningを経てreadyにする試行。`connecting`または`provisioning`で失敗するか、readyになって終了する。session closeと競合して中断された場合も`aborted`として完了recordを残す。
- **attempt cycle**: initial open、またはready後の一つのcanonical dropを起点に、次のreadyまたはterminal outcomeまで続くattemptのまとまり。initial cycleは`cycle: 0`かつ`origin: "initial"`である。ready後のcanonical dropごとにcycleを1増やし、`origin: "recovery"`とする。
- **recovery cycle**: `origin: "recovery"`であるattempt cycle。起点の`UniplsDrop`、同じlogical session、回復を継続するoperationとsession-scoped resourceを保持する。ready、user close、recovery cancel/exhaustion、reconnector failureのいずれかで終わる。
- **ready**: current epochのtransportがopenし、session setup（未成功の場合）、connection setup、detector setupがすべて成功し、通常operation用の送受信barrierを開いた状態。公開lifecycleでは`phase: "open"`で表す。`open()`というmethod名やopen intentと混同しない。
- **drop**: activeなopen intentの下でcurrent epochを失ったという、一度だけ確定する事実。peer close、transport error、timeout、detector、manual dropを`UniplsDrop`へ正規化する。attemptのprovisioning failureはattempt failureであり、それ自体を架空のdropへ変換しない。
- **operation**: `cast`、`next`、`request`、`listen`、`subscribe`の一回の呼び出し。入力検証後、active sessionの確認とsessionへの登録を連続した同期区間で行い、この登録を受付のlinearization pointとする。
- **settle / finalize**: Promise系operationのresolve/reject、またはstreamの終了結果を一度だけ確定すること。各operationは一つのsettle gateだけを持ち、cleanupを全件試行した後に結果を外部へ通知する。

公開する`SessionId`、`ConnectionId`、`OperationId`は、それぞれ別のbrandを持つopaqueな`string`とする。`ConnectionId`はtransport epochの公開identityであり、物理socket objectやready済み接続だけを指すIDではない。値はlibraryだけが発行し、利用者が保証される操作は同じkind同士の厳密等価比較、Map/Setのkeyとしての利用、log出力だけである。文字列形式、長さ、生成方式、辞書順、session/connection間の包含関係はcontractにしない。数値への変換やIDから時刻・順序を復元する利用も保証しない。

公開declarationの意味は次の形とする。brand symbol自体はexportせず、IDのruntime valueは通常のstringである。

```ts
declare const sessionIdBrand: unique symbol;
declare const connectionIdBrand: unique symbol;
declare const operationIdBrand: unique symbol;

export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };
export type ConnectionId = string & {
  readonly [connectionIdBrand]: "ConnectionId";
};
export type OperationId = string & {
  readonly [operationIdBrand]: "OperationId";
};
```

### connection attempt/history record

`cycle`と`attempt`は0/1始まりのcycle-localな位置、`sequence`は1始まりのsession全体で単調増加する番号である。initial cycleでは`cycle === 0`、各recovery cycleでは`cycle >= 1`である。`attempt`は各cycleで1から始まる。これらはopaque IDではなく、policyと診断のための順序値である。

```ts
type ConnectionAttemptOrigin = "initial" | "recovery";
type ConnectionAttemptStage = "connecting" | "provisioning";

type ConnectionAttemptSnapshot =
  | Readonly<{
      sequence: number;
      cycle: number;
      attempt: number;
      origin: ConnectionAttemptOrigin;
      connection: ConnectionId;
      startedAt: number;
      endedAt: number;
      outcome: "ready";
    }>
  | Readonly<{
      sequence: number;
      cycle: number;
      attempt: number;
      origin: ConnectionAttemptOrigin;
      connection: ConnectionId;
      startedAt: number;
      endedAt: number;
      outcome: "failed";
      stage: ConnectionAttemptStage;
      cause: unknown;
      drop?: UniplsDrop;
    }>
  | Readonly<{
      sequence: number;
      cycle: number;
      attempt: number;
      origin: ConnectionAttemptOrigin;
      connection: ConnectionId;
      startedAt: number;
      endedAt: number;
      outcome: "aborted";
      stage: ConnectionAttemptStage;
      reason: "session-closed";
    }>;
```

`startedAt`、`endedAt`、`detectedAt`、diagnosticの`occurredAt`はUnix epochからのmillisecondsであり、観測・log用である。system clockの補正下で差分が正のdurationになることは保証しない。timeoutとdeadlineの判定にはこれらを使わず、D7のmonotonic clockを使う。

`attempts`はそのlogical sessionで完了した全attemptを`sequence`順に持つfrozen readonly arrayである。record本体、array、record内のlibrary-owned metadataもruntimeでfreezeする。attempt完了ごとに新しいarray snapshotを作り、既に公開したarrayへ追記しない。`cause`はopaqueなuser/host valueとしてcloneもdeep-freezeもしない。reconnector、lifecycle、domain errorが同じ時点の履歴を示す場合は同じarrayとrecordのidentityを共有する。

進行中のattemptは`attempts`へ未完了recordを入れず、`connecting`/`provisioning` snapshotの`connection`、`cycle`、`attempt`、`origin`で示す。attemptがready、failed、abortedのいずれかへ確定したときだけhistoryへ追加する。

### lifecycle snapshotの最終形

initial attempt failure後にreconnector actionを待つ間は`connecting`の`status: "waiting"`とする。ready済みsessionのrecovery action待ちは`recovering`とする。これにより、provisioning failureを架空のdropへ変換せず、かつ物理attemptが存在しない待機を`status: "attempting"`と誤表示しない。

```ts
type ClosedLifecycleSnapshot =
  | Readonly<{ phase: "closed"; reason: "idle" }>
  | Readonly<{
      phase: "closed";
      reason: "user";
      session: SessionId;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>
  | Readonly<{
      phase: "closed";
      reason: "open-failed";
      session: SessionId;
      outcome: UniplsOpenErrorOutcome;
      attempts: readonly ConnectionAttemptSnapshot[];
      cause: unknown;
      drop?: UniplsDrop;
    }>
  | Readonly<{
      phase: "closed";
      reason: "dropped";
      session: SessionId;
      outcome: Exclude<UniplsDroppedErrorOutcome, "operation-failed">;
      attempts: readonly ConnectionAttemptSnapshot[];
      drop: UniplsDrop;
      cause?: unknown;
    }>;

type AttemptingLifecycleFields = Readonly<{
  status: "attempting";
  session: SessionId;
  connection: ConnectionId;
  cycle: number;
  attempt: number;
  attempts: readonly ConnectionAttemptSnapshot[];
}> &
  (
    | Readonly<{ origin: "initial" }>
    | Readonly<{ origin: "recovery"; drop: UniplsDrop }>
  );

type UniplsLifecycleSnapshot =
  | ClosedLifecycleSnapshot
  | Readonly<{
      phase: "connecting";
      status: "waiting";
      session: SessionId;
      origin: "initial";
      nextAttempt: number;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>
  | (Readonly<{ phase: "connecting" }> & AttemptingLifecycleFields)
  | (Readonly<{ phase: "provisioning" }> & AttemptingLifecycleFields)
  | Readonly<{
      phase: "open";
      session: SessionId;
      connection: ConnectionId;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>
  | Readonly<{
      phase: "recovering";
      session: SessionId;
      drop: UniplsDrop;
      nextAttempt: number;
      attempts: readonly ConnectionAttemptSnapshot[];
    }>;
```

`reason: "idle"`はinstance生成後まだsessionを開始していない状態だけを表す。active sessionに対する明示`close()`は、初回ready前、ready後、recovery中のどこで呼ばれても`reason: "user"`へ収束する。初回ready前のterminal attempt/policy failureは`reason: "open-failed"`、一度readyになった後のrecovery cancel/exhaustion/reconnector failureは`reason: "dropped"`である。`operation-failed`は個別operationのoutcomeでありsession terminal outcomeではないため、closed lifecycleの`outcome`には現れない。

`close()`を`closed`で呼ぶことは冪等なno-opであり、snapshot object identityを変更しない。次の`open()`だけが新しいsessionを作る。すべてのsnapshot、その`attempts` array、library-ownedなネストmetadataはruntimeでfreezeし、同じ状態の間はgetterが同じobjectを返す。

### lifecycle状態遷移表

表中の「attempt failure」はtransport生成/接続失敗、connection timeout、provisioning failureを含む。cleanup failureはどの遷移も変更せずdiagnosticだけを追加する。表にないstale transport epoch eventとsettle済みreconnector actionはno-opである。

| 現在 | 入力・条件 | 次 | session / epochと外部結果 |
| --- | --- | --- | --- |
| `closed(*)` | `open()`の入力検証成功 | `connecting(attempting, initial)` | 新しいsessionとcycle 0/attempt 1のepochを同期的に作る。`open()`はpending。 |
| `closed(*)` | 5 operation | 変更なし | operationを作らず同期的に`UniplsInvalidUsageError`をthrowする。 |
| `connecting(waiting, initial)` | 有効な`reconnect()` action | `connecting(attempting, initial)` | 同じsessionで`nextAttempt`の新epochを作る。 |
| `connecting(attempting)` | current transportのopen | `provisioning(attempting)` | 同じsession/transport epoch/attemptを維持し、setup transactionを開始する。 |
| `provisioning(attempting)` | setup成功 | `open` | `ready` attempt recordを追加しbarrierを開く。session最初のreadyなら`open()`をresolveする。 |
| `connecting` / `provisioning`（initial） | attempt failure後、policyが将来のactionを待つ | `connecting(waiting, initial)` | `failed` recordを追加し、同じsessionを維持する。`open()`はpending。 |
| `connecting` / `provisioning`（initial） | attempt failure後、policyが即retry | `connecting(attempting, initial)` | failed epochを先に無効化/cleanupし、新epochで次attemptを開始する。 |
| `connecting` / `provisioning`（initial） | reconnectorなし、cancel、exhaustion、reconnector failure | `closed(open-failed)` | sessionをterminalにし、`open()`を対応する`UniplsOpenError`でrejectする。 |
| `open` | peer close/error/timeout/detector/manual dropがdrop gateを最初に通過 | `recovering` | epochを同期的に無効化し、一つのcanonical dropと新しいrecovery cycleを確定する。operationへdrop policyを一度だけ適用する。 |
| `recovering` | 有効な`reconnect()` action | `connecting(attempting, recovery)` | 同じsession/dropを維持し、cycle内の次attempt用epochを作る。 |
| `connecting` / `provisioning`（recovery） | attempt failure後、policyが待機 | `recovering` | `failed` recordを追加し、cycle起点の同じdropを保持する。 |
| `connecting` / `provisioning`（recovery） | attempt failure後、policyが即retry | `connecting(attempting, recovery)` | failed epochをcleanup後、同じcycleの次attemptを開始する。 |
| `recovering`またはrecovery attempt中 | cancel / exhaustion / reconnector failure | `closed(dropped)` | session scopeを終了し、継続中operationを同じterminal `UniplsDroppedError`でsettleする。 |
| 任意のactive phase | 利用者の`close()`が先にsession terminal gateを通過 | `closed(user)` | current epochを先に無効化し、全operationをclose outcomeへ進め、全resourceのcleanup完了後に`close()`をresolveする。 |
| 任意のactive phase | current attempt中の`close()` | `closed(user)` | 進行中attemptを`aborted/session-closed`としてhistoryへ追加する。pending `open()`は`UniplsClosedError`でrejectする。 |
| 任意 | currentでないtransport epochのevent/provisioning完了/drop報告 | 変更なし | callback固有の後始末以外を行わず、current session/transport epoch/operationへ通知しない。 |
| `closed(*)` | `close()` | 同じsnapshot | 完了済みcleanup Promiseがあればそれを返し、なければ即時resolveする。 |

同じJavaScript turnでuser closeとdropが競合した場合、session/epochの同期settle gateを先に通過した入力が分類を確定する。dropが先でも、その後recovery中に利用者が`close()`を呼べば最終session outcomeは`closed(user)`である。既にcancel/exhaustion/reconnector failureがsession terminal gateを通過した後の`close()`は`closed(dropped)`を変更しない。

### operation behavior matrix

全operationで、wrong type/必須値欠落は`TypeError`、timeoutやbuffer値の範囲不正は`RangeError`としてsession確認より前に同期throwする。入力snapshot/validation後は、active sessionの最終確認とoperation登録の間にuser codeを呼ばない。既にabort済みのsignalは、active session内では受付済みoperationのabort outcomeであり、invalid usageの同期throwではない。

| operation | `closed(*)`で開始 | `connecting` / `provisioning`で開始 | `open`で開始 | `recovering`で開始 | 一度readyになった後のdrop時の既定 | 成功結果 |
| --- | --- | --- | --- | --- | --- | --- |
| `cast` | 同期`UniplsInvalidUsageError` | 受付後、最初のreadyまで待つ。factoryは未評価 | ready epochでfactory評価、serialize、send | 次のreadyまで待ち、初回sendする | `fail`。送信を試みた未settle castを暗黙再送しない | transportがsendを受理した時点で`Promise<void>` resolve。peer受信は保証しない |
| `next` | 同期`UniplsInvalidUsageError` | 受付後、最初のreadyからselectorを有効化 | selectorに最初に一致したmessageを待つ | 次のreadyから観測を始める | `wait`。drop中とprovisioning中は観測停止し、次のready後に再開 | 最初の一致messageでresolve |
| `request` | 同期`UniplsInvalidUsageError` | 受付後、最初のreadyでfactory評価、send後にselectorを有効化 | send完了後に届く一致messageを待つ | 次のreadyで初回sendする | `fail`。明示`wait`は再送せずready後に応答待ちだけ再開、`resend`/customだけ再送 | send後の最初の一致messageでresolve |
| `listen` | 同期`UniplsInvalidUsageError` | 受付後、最初のreadyから観測 | ready中の一致messageを配送 | 次のreadyから観測 | `wait`。drop/provisioning中は観測停止しready後に再開 | terminator/unsubscribe/closeまたはfailureまで0..N件を配送 |
| `subscribe` | 同期`UniplsInvalidUsageError` | 受付後、最初のreadyでfactory評価、send後に観測 | send完了後の一致messageを配送 | 次のreadyで初回send | `fail`。明示`wait`は再送せず観測だけ再開、`resend`/customだけ再送 | terminator/unsubscribe/closeまたはfailureまで0..N件を配送 |

ready前に受け付けられ、まだ一度も送信・観測していないoperationはdrop recoveryの対象ではない。現在のattemptが失敗しても同じsessionの次のreadyを待ち、`retry: "fail"`でも初回実行する。factoryは実際の初回send直前まで評価しない。一度sendを試みたpayloadはpeerへの到達可否が不明なので、明示`resend`またはcustom recoveryなしに再送しない。

`request`/`subscribe`はsend完了前に届いたmessageを結果にしない。`next`/`listen`を含む通常operationはprovisioning中のmessageに対してselector/terminator/callbackを実行しない。dropを`wait`でまたぐoperationも、新epochのprovisioning messageを観測しない。

operationの終了結果は次のとおりである。Promise系の「reject値」とAsyncIterableの「throw値」とstream finalizationの`error`は同じobject/value identityを使う。

| 終了入力 | `cast` / `next` / `request` | callback stream / AsyncIterable `closed` | AsyncIterable |
| --- | --- | --- | --- |
| 通常成功 | resolve | 継続 | messageをyield |
| terminator一致 | 該当なし | `{ ok: true, reason: "terminated", message }` | terminal messageをyieldせず正常終了 |
| `unsubscribe()` / iterator `return()` | 該当なし | `{ ok: true, reason: "unsubscribed" }` | bufferを破棄して正常終了 |
| 利用者のsession `close()` | `UniplsClosedError`でreject | `{ ok: true, reason: "closed" }` | 正常終了 |
| initial open terminal failure | `UniplsOpenError`でreject | `{ ok: false, reason: "open-error", error }` | 同じerrorをthrow |
| operationの`fail`またはrecovery terminal outcome | `UniplsDroppedError`でreject | `{ ok: false, reason: "dropped", error }` | 同じerrorをthrow |
| deadline到達 | `UniplsTimeoutError`でreject | `{ ok: false, reason: "timeout", error }` | 同じerrorをthrow |
| `AbortSignal` | `signal.reason`でreject | `{ ok: false, reason: "aborted", error: signal.reason }` | 同じ値をthrow |
| buffer overflow `"error"` | 該当なし | `{ ok: false, reason: "buffer-overflow", error }` | 同じ`UniplsBufferOverflowError`をthrow |
| callback throw + `"unsubscribe"` | 該当なし | `{ ok: false, reason: "callback-error", error }` | 該当なし |
| factory/serializer/predicate fail-fast等 | 元の値でreject | `{ ok: false, reason: "fatal-error", error }` | 同じ値をthrow |

streamの`closed`は全行でrejectせず、settle gateの勝者を確定し全cleanupを一度ずつ試行した後に、一つのfrozen finalizationでresolveする。cleanup failureはこの表の結果を変更しない。

### timeout、readiness、stream finalizationのcontract例

以下は後続contract testが固定する時系列である。

1. **ready待機もdeadlineに含む**: `t=0`の`connecting`中に`request({ timeout: 100, query: factory })`を受け付ける。`t=100`までreadyにならなければfactoryを一度も呼ばず`UniplsTimeoutError`でrejectする。`t=100`後にready eventが来ても送信しない。
2. **retryでdeadlineをリセットしない**: `t=0`に`next({ timeout: 100, retry: "wait" })`を開始し、`t=40`にdrop、`t=90`に再びreadyになってもdeadlineは元の`t=100`である。`t=100`まで一致messageがなければtimeoutし、epochごとに残り100msへ戻さない。
3. **readinessは送受信共通**: provisioning中にmessage A、ready遷移後にmessage Bを受信した場合、通常`next`/`listen`のselectorはAに対して呼ばれずBだけを観測できる。connection setup contextのtransport-epoch-bound receive capabilityはAを観測できるが、Bを通常operationと重複配送する権利はない。
4. **recovery中の初回send**: recovery待機中に`request({ retry: "fail", query: factory })`を開始しても即時失敗せずfactoryも評価しない。次のreadyでfactoryを初めて評価して一度送る。この送信後にさらにdropした場合だけ`retry: "fail"`を適用する。
5. **terminatorはdataではなく終了理由**: stream messageにterminatorが一致したらselectorを評価せず、callback/yieldへ渡さない。cleanup後に`closed`を`{ ok: true, reason: "terminated", message }`でresolveし、AsyncIteratorは正常終了する。
6. **終了競合はfirst-wins**: timeout callbackと一致messageが同じturnで競合した場合、共通settle gateを最初に通過した側だけを採用する。後発側はfinalization、callback、cleanupを二重実行しない。
7. **abort reasonを包まない**: `const reason = { code: "stop" }`でsignalをabortした場合、Promise/iteratorが投げる値と`closed`の`error`はすべて`reason`と厳密等価である。
8. **closeはstreamの正常終了**: session `close()`はcallback streamとAsyncIterableを`{ ok: true, reason: "closed" }`へfinalizeし、iteratorをthrowさせない。一方、同じstreamがrecovery exhaustionで終わる場合は`dropped` finalizationとなりiteratorはその`UniplsDroppedError`をthrowする。

## 作業順序

### Phase 0: 判断と安全網

#### Task 0: lifecycle と公開契約の decision record を確定する

- [x] D1 について採用案、理由、実装上の帰結、互換性への影響を記録する。
- [x] D2 について採用案、理由、公開形、実装上の帰結、互換性への影響を記録する。
- [x] D3 について採用案、理由、公開形、実装上の帰結を記録する。
- [x] D4 について採用案、理由、公開形、実装上の帰結を記録する。
- [x] D5 について採用案、理由、公開形、実装上の帰結を記録する。
- [x] D6 について採用案、却下案、理由、公開形、実装上の帰結、互換性への影響を記録する。
- [x] D7 について採用案、却下案、理由、公開形、実装上の帰結、互換性への影響を記録する。
- [x] D8 について採用案、却下案、理由、公開形、実装上の帰結、互換性への影響を記録する。
- [x] D9 について採用案、却下案、理由、公開形、実装上の帰結、互換性への影響を記録する。
- [x] D10 について採用案、却下案、理由、公開形、実装上の帰結、互換性への影響を記録する。
- [x] D11〜D12 について採用案、却下案、理由、互換性への影響を記録する。
- [x] D13について初期releaseでの非採用、内部dispatcher境界、将来追加時の互換条件を記録する。
- [x] session、connection attempt/transport epoch、recovery cycle、operation の用語を定義する。
- [x] `open`、ready、drop、retry、cancel/exhaust、reconnector failure、close の状態遷移表を作る。
- [x] 5 operation について、各 state での開始可否、drop 時の既定動作、settle 結果を matrix にする。
- [x] timeout/readiness/stream finalization の contract 例を記す。

成果物:

- 実装が参照できる decision record と behavior matrix。
- 必要なら `overview.md` の曖昧な表現の更新。

完了条件:

- 後続タスクのテスト期待値を、実装を見ずに決められる。
- D6〜D13 に未決事項が残っていない。

依存: なし。

#### Task 1: 静的検査と CI の基礎を修復する

- [x] Vite+ が `vite.config.ts` を読み込めず `check` が停止する問題を直す。
- [x] build targetをES2022へ固定し、Node `22.4.0`、Deno `2.0.0`、Bun `1.2.0`と各最新stable、最新2安定版相当のChromium/Firefox/WebKitをCI matrixへ追加する。
- [x] 各最低runtimeでnative `AbortSignal.any`の優先順位、reason identity、後発abort不変性を検証し、polyfillをtest環境から暗黙注入しない。
- [x] format check、lint、型検査、test、build を独立した script にする。
- [x] test runnerとCIが公開contractの`*.spec.ts`とそれ以外の`*.test.ts`をともに収集し、結果上も区別できるようにする。
- [x] `tests/reference/**`をtest runner、型検査、coverage、test件数から除外し、referenceが壊れても修正を要求しない。
- [x] 最初のnormativeな`*.spec.ts`/`*.test.ts`を追加した時点で移行用の`passWithNoTests: true`を除去し、収集対象が0件ならCIを失敗させる。
- [x] package 単体で型検査を実行できるようにする。
- [x] 各検査を CI の独立 job、または失敗を個別に識別できる step にする。
- [x] referenceへ退避した旧suiteをgreenにする作業は行わず、Task 0以降に新規作成したnormative testとbuildだけをCI baselineとして維持する。test件数を固定値として完了条件にしない。

完了条件:

- clean checkout で全検査を 1 コマンドずつ再現できる。
- format/lint failure が型検査の実行可否を隠さない。
- 最低versionと最新stableのruntime matrixが同じsource/tarballを検証する。

適用する決定: D12。

依存: Task 0 と並行可能。ただし runtime matrix は D12 確定後に固定する。

#### Task 2: race を再現できる contract test harness を整備する

- [x] WebSocket の open/message/close と close code を任意の順序で制御できるようにする。
- [x] provisioning と reconnector を resolve/reject/cancel の各地点で停止できるようにする。
- [x] callback 回数、listener/timer/disposer の解放を観測できる test utility を用意する。
- [x] stale connection event、二重 open、close/reconnect 競合を組み立てられる scenario helper と harness 自体の test を追加する。
- [x] 同じepochへ複数detectorとsocket close/errorを任意順で報告し、最初のdropだけが採用されるrace scenarioを追加する。
- [x] implementation class ではなく public API 経由で検証する。
- [x] harness自体のtestは`*.test.ts`、harnessを使って公開APIの契約を検証するscenarioは`*.spec.ts`に置く。

完了条件:

- plan に挙げた未検証 race を、後続タスクの contract test から実時間 sleep に依存せず決定的に再現できる。
- 既存 test utility と責務が重複していない。
- 現在の誤った挙動を characterization test として仕様化していない。

適用する決定: D2、D3、D4、D5。

依存: Task 0。

### Phase 1: lifecycle の正規化

#### Task 3: logical session と transport epoch を分離する

- [ ] session ID を発行・所有する単一の session model を導入する。
- [ ] 物理接続の試行にはsessionと異なる内部transport epochを与え、公開境界ではそのidentityを`ConnectionId`で表す。
- [ ] provisioning/reconnector/event が同じ論理 session ID を参照するようにする。
- [ ] session setupの未実行/成功済みを論理session stateへ明示的に保持し、物理IDのSetや公開`isSessionBeginning` flagから推測しない。
- [ ] 二重 `open()` の妥当性検証を、provisioner/session の変更より前に行う。
- [ ] 失敗した `open()` が既存 session を変更しないことを test する。
- [ ] lifecycle coordinator を状態の唯一の writer とし、D2 の frozen snapshot を遷移ごとに生成する。
- [ ] `unipls.lifecycle` getter と `{ previous, current }` を持つ lifecycle event を実装する。
- [ ] 最初に ready になるまで `open()` を pending に保ち、D3 の attempt outcome に従って resolve/reject する。

完了条件:

- 再接続前後で session ID が不変である。
- session setupはlogical sessionで一度だけ成功し、connection setupはreadyになる各transport epochで一度ずつ成功する。
- session を表す state holder と ID generator が重複していない。
- lifecycle event の dispatch 時に `unipls.lifecycle === event.current` が成立し、次の遷移まで getter の object identity が安定している。

適用する決定: D2、D3。

依存: Task 2。

#### Task 4: transport epoch を隔離し、古い処理を中断する

- [ ] raw open/message/error/closeを作成元transport epochに束縛する。
- [ ] currentでないtransport epochのeventがpublic stateとoperationを変更しないようにする。
- [ ] connection 交代時に古い provisioning、送信待機、connection-scoped resource を abort する。
- [ ] 待機送信がeventのtransport epochと同じsocketにだけ送るようにする。
- [ ] 古い provisioning の遅延完了、古い message/close/error の race test を追加する。
- [ ] detector contextを含む全connection callbackに作成元transport epoch IDをcaptureさせ、古いtransport epochからのdrop報告を無効化する。

完了条件:

- stale transport epochからready eventやmessageが発生しても現在のconnectionに影響しない。
- transport epoch終了後にそのtransport epochのcallback、timer、listenerが残らない。

適用する決定: D2、D9。

依存: Task 3。

#### Task 5: close/drop の分類と収束を統一する

- [ ] user close intent と transport close metadata を別に扱う。
- [ ] server code 1000、非 1000、接続前 close、socket 生成失敗をD5に従ってuser closeまたはdropへ一度だけ分類する。
- [ ] peer close、transport error、timeout、detector、manual dropからfrozen `UniplsDrop`を生成する。
- [ ] 全drop検出経路をtransport-epoch-scopedな同期`reportDrop()` gateへ集約し、check-and-set完了前にawait、cleanup、event dispatch、user callbackを実行しない。
- [ ] 最初のdrop報告でepochを同期的に無効化してcanonical dropを確定し、その勝者だけがcleanupと一つのrecovery cycleを開始する。後発報告は同じepochのno-opにする。
- [ ] detector由来dropにはfrozenなdetector identityをsourceとして保持し、複数detectorが反応した場合はsettle gateの最初の勝者を記録する。
- [ ] dropped/no-socket の状態から `close()` しても必ず terminal state に収束させる。
- [ ] close/drop event と operation termination を exactly once にする。
- [ ] close と reconnect action が競合しても古い action が復活しないようにする。
- [ ] cancel/exhaustion/reconnector failureでsession scopeを終了し、`closed(reason: "dropped")`のfrozen snapshotへatomicに遷移する。

完了条件:

- 状態遷移表のすべての close/drop ケースが contract test で網羅される。
- `close()` 完了後にopen intent、active transport epoch、recovery timerが残らない。
- recovery terminal outcome 後に session-scoped resource と pending operation が残らず、次の `open()` が新しい session ID を作る。
- 同じepochについてdetector、socket、timeoutが重複してdropを報告しても、canonical drop、drop/lifecycle通知、cleanup、recovery cycle、reconnector起動がそれぞれ一回だけである。

適用する決定: D2、D4、D5、D11。

依存: Task 4。

#### Task 6: reconnection engine に明示的な outcome を導入する

- [ ] connection と provisioning の失敗を 1 回の attempt outcome に統一する。
- [ ] initial と recovery で同じ engine を使い、policy context に `origin`、`stage`、attempt 番号、原因を渡す。
- [ ] reconnect policyへcanonicalな`UniplsDrop`を渡し、close code固有のretry/terminal判定をpolicy側で行えるようにする。
- [ ] `retrying`、`succeeded`、`cancelled`、`exhausted`、`reconnector-failed`、`session-closed`を明示的なoutcomeとして表す。
- [ ] reconnector setup/policy errorを握りつぶさず`reconnector-failed` terminal outcomeとsession-scoped diagnosticへ変換し、context、failure point、元のcauseを保持する。
- [ ] cancel/exhaustion、reconnector failureと失敗後の次回 setup を一貫して処理する。
- [ ] attempt 履歴を immutable snapshot にし、開始・終了・結果・原因を記録する。
- [ ] cleanup と action を冪等にし、settle 後の `reconnect/cancel` を無効化する。
- [ ] `cancel` / exhaustion / reconnector failureをsession coordinatorへterminal outcomeとして通知し、同じsessionを再開できないようにする。

完了条件:

- recovery の全経路に terminal outcome があり、無期限に宙ぶらりんになる経路がない。
- reconnectorがthrow/rejectしてもsession resourceとpending operationが一度だけ終了し、元のcauseを`UniplsOpenError`または`UniplsDroppedError`から参照できる。
- 初回接続と再接続に同じ attempt model を適用できる。
- reconnector がある初回失敗では `open()` が retry 中に reject せず、最初のready、cancel/exhaust、reconnector failure、close/abortのいずれかで一度だけsettleする。
- policy から内部履歴を書き換えられない。

適用する決定: D3、D4、D5、D11。

依存: Task 5。

### Phase 2: operation lifecycle の統一

#### Task 7: operation 共通 lifecycle を導入する

- [ ] operation を論理 session、deadline、AbortSignal、readiness に束縛する共通 primitive を作る。
- [ ] operation lifecycleとmessage dispatchを分離し、operation registration、unregistration、message deliveryを担うinternal `MessageDispatcher`境界を導入する。
- [ ] 初期dispatcherはactive operationを候補にするbroadcast実装とし、各operationがraw message eventへ直接listenerを登録する現行構造を廃止する。
- [ ] dispatcherは候補選択だけを担当し、selector/terminator評価、predicate error policy、settle gate、timeout、drop/recovery、cleanupをoperation共通primitiveに残す。
- [ ] ready 待機、session close、recovery terminal outcome を一つの終了経路へ正規化する。
- [ ] timeoutを受付時から進むmonotonicなwall-clock deadlineとして統一し、provisioning/recovery/retry待機を含める。
- [ ] `undefined`だけを無期限とし、有限の正数でないtimeoutをoperation登録前に同期throwする。
- [ ] message factoryとserializerの例外を元のcauseを保ったoperation resultへ変換する。
- [ ] deserializer failureは該当messageだけを破棄し、active operationを終了させずconnection-scoped diagnosticを通知する。
- [ ] selector/terminator throwは該当operationについてmessageを破棄し、operation-scoped diagnosticを通知して既定では継続する。`predicateError: "fail"`だけをterminal outcomeへ流す。
- [ ] predicate diagnosticを`message-predicate-failed` variantとして型付けし、`severity: "error"`、predicate種別、policy、causeを持たせる一方、message本体や取得不能な相関IDを含めない。
- [ ] cleanup を user callback より先に確定し、全終了経路で exactly once にする。
- [ ] 通常receive operationをready-gated受信経路へ、provisioning contextのreceive operationをtransport-epoch-bound受信経路へ分離する。
- [ ] provisioning messageを通常receive operationへbuffer/replayせず、通常selectorも評価しないことをcontract testにする。
- [ ] active recovery中に開始したoperationをsessionの次のready/terminal outcomeへ接続し、socket stateだけを理由に失敗させない。
- [ ] active sessionの確認とoperationのsessionへの登録を同期的なlinearization pointにまとめ、登録前にuser codeへ再入しない。
- [ ] open intent外からの5 operationは同期的な`UniplsInvalidUsageError`、受付後の終了は非同期のoperation outcomeになることを共通contract testにする。

完了条件:

- listener、timer、abort listener が成功・失敗・中断のすべてで解放される。
- 瞬間的な socket state を直接見て開始可否を分岐する operation がない。
- 受付済みoperationと、その受付後に生じたclose/dropを同じsession IDで追跡できる。
- timeoutとresponse、abort、closeが競合しても一つのoutcomeだけが採用され、deadline到達後にepochが変わってもoperationが復活しない。
- ready境界の前後でmessageの観測先が一意に決まり、通常operationがprovisioning中のmessageを観測しない。
- 一つのmessageが複数operationのselectorに一致するbroadcast semanticsを維持しながら、dispatcher実装を差し替えてもoperation lifecycleを再実装する必要がない。

適用する決定: D6、D7、D8、D10、D11。

依存: Task 6。

#### Task 8: 単発 operation を共通 lifecycle へ移行する

- [ ] `cast`、`next`、`request` を Task 7 の primitive へ移行する。
- [ ] active recovery 中に開始した初回送信・受信待機を次の ready connection へ接続する。
- [ ] 未送信の初回送信と、送達不明になったpayloadの再送を状態として区別する。
- [ ] `fail`、`wait`、`resend`、custom recovery を reconnection outcome と統合する。
- [ ] resend 時だけ factory を再評価し、初回送信と再送を区別する。
- [ ] cancel/exhaustion、reconnector failure、close、timeout、abort、factory error の結果を test する。
- [ ] cancel/exhaustion/reconnector failureではpending operationをoutcomeと最後の原因を持つ`UniplsDroppedError`で一度だけrejectする。
- [ ] `UniplsDroppedError`から、原因となったcanonicalな`UniplsDrop`を`drop` propertyで参照できるようにする。
- [ ] 同一 message に複数 selector が一致する broadcast contract を維持する。
- [ ] `cast`、`next`、`request`はopen intent外でPromiseを作らず、同期的に`UniplsInvalidUsageError`をthrowする。
- [ ] ready前・初回送信後・recovery/retry待機中それぞれのwall-clock timeoutをclock制御下でtestする。
- [ ] `next`はprovisioning中のmessageを無視して次のready後から観測し、待機中もD7のdeadlineが進むことをtestする。
- [ ] `next` / `request`でpredicate errorの既定継続と明示failをtestし、他operationへの同一message fan-outが止まらないことを確認する。

完了条件:

- dropped/reconnecting 中に開始した単発 operation が必ず送信・解決・失敗のいずれかへ進む。
- 暗黙の resend を行わない。
- recovery 終了後に reconnect listener が残らない。

適用する決定: D4、D6、D7、D8、D11。

依存: Task 7。

#### Task 9: stream operation を共通 lifecycle へ移行する

- [ ] 冪等な`unsubscribe()`と非rejectingな`closed`を持つfirst-class subscription handleを実装する。
- [ ] 全終了経路を共通settle gateへ流し、cleanup完了後にfrozenなfinalization unionで`closed`を一度だけresolveする。
- [ ] `listen` と `subscribe` を同じ終了・unsubscribe・deadline model へ移行する。
- [ ] `next`の有無でcallback handleとsingle-consumerなAsyncSubscriptionを返し分ける型安全なoverloadを実装する。
- [ ] callbackの同期throwをoperation-scopedな`stream-callback-failed` diagnosticへ隔離し、`severity: "error"`、cause、policyを通知する。既定の継続と`callbackError: "unsubscribe"`をtestする。
- [ ] callbackが返すPromiseを待機・観測せず、非同期rejectをlibrary diagnosticに変換しないことと逐次性を保証しないことをdocumentする。
- [ ] active recovery中に作られたstreamを次のready connectionから開始し、terminal outcome前にfinalizeしない。
- [ ] finalizationをliteral booleanの`ok`と`reason`によるdiscriminated unionにし、`terminated`、`unsubscribed`、`closed`だけを`ok: true`、その他を`ok: false`かつ`error`必須にする。
- [ ] `callbackError: "unsubscribe"`は`callback-error`として利用者自身のunsubscribeと区別し、AsyncIterator/Promiseとfinalizationが同じerror値を参照するようにする。
- [ ] cancel/exhaustion/reconnector failureでは全streamを一度だけfinalizeし、古いsessionのstreamを次の`open()`へ引き継がない。
- [ ] user callback error を cleanup と他 subscriber から隔離する。
- [ ] terminatorをselectorより先に評価し、一致時はterminal messageをcallback/yieldせず`closed`の`terminated.message`だけに保持することをtestする。
- [ ] 既存 callback API を残す場合は adapter として実装し、互換性 test を付ける。
- [ ] `listen`、`subscribe`はopen intent外でterminal handleを作らず、同期的に`UniplsInvalidUsageError`をthrowする。
- [ ] streamのtimeoutはtransport epochごとにリセットせず、受付からの一つのdeadlineで一度だけfinalizeする。
- [ ] `listen`はprovisioning中とdrop中に観測を停止し、次epochのready後にだけ再開する。
- [ ] AsyncIterable adapterをoperation開始時に作り、有限の既定buffer、数値指定、`latest`、3種のoverflow policy、message-loss診断を実装する。
- [ ] 実装前に既定buffer capacityの具体値をpublic documentationへ記録し、capacityちょうど、capacity超過、`0`/負数/非有限値のvalidationをcontract testで固定する。
- [ ] lossy buffer policyで破棄したmessageごとに`stream-message-dropped` warningを通知し、strategyとcapacityだけを公開する。listener不在時のfast pathと、overflow `"error"`で重複診断しないことをtestする。
- [ ] iterationのbreak/returnをunsubscribeへ写像し、terminator/close/unsubscribeは正常終了、operation failureはthrow、`closed`は常にresolveとなることをtestする。
- [ ] subscriptionへ`Symbol.dispose`/`Symbol.asyncDispose`を追加せず、frameworkのdisposer引数には`() => subscription.unsubscribe()`を渡す移行例をdocumentする。
- [ ] coreがtransport backpressureを保証しないこととsingle-consumer制約をdocumentする。
- [ ] streamのselector/terminator throwで既定継続と明示failをtestし、terminator評価に失敗したmessageをyield/callbackしない。

完了条件:

- finalization は理由にかかわらず一度だけ通知される。
- `if (!finalization.ok)`で全failure variantと`error`へ型narrowingでき、正常終了には`error`が存在しない。
- callback throw が event fan-out と resource cleanup を止めない。
- stream の consumer が終了を await できる。
- `closed`を監視しないconsumerでもfailure時にunhandled rejectionが発生しない。

適用する決定: D4、D6、D7、D8、D10、D11。

依存: Task 8。API の骨格は Task 7 後に並行検討可能。

### Phase 3: provisioning と extension の所有権

#### Task 10: provisioning capability と resource scope を再設計する

- [ ] provisioning contextに通常APIとは分離したtransport-epoch-bound receive capabilityを持たせ、provisioning完了またはtransport epoch終了時に一時receive operationを失効させる。
- [ ] provisioning context外からreadiness barrierを迂回できないことを型とruntimeの両方でtestする。
- [ ] provisioning contextをtransport epochに束縛する。
- [ ] provisionerをsession setupとconnection setupへ分け、`isSessionBeginning`を削除する。function shorthandを残す場合はconnection setupへ写像する。
- [ ] session scopeとconnection scopeにそれぞれ`defer`相当の即時disposer登録とhook戻り値の取り込みを実装する。
- [ ] 専用`ResourceScope`に任意のscope-localな一意nameと登録元metadata、LIFOの逐次async cleanup、memoizedなdispose Promise、dispose開始後の登録拒否を実装する。標準`DisposableStack`の有無に挙動を依存させない。
- [ ] `defer(disposer, { name? })`を公開し、nameを省略したresourceの個別識別を保証せず、library-owned resourceには安定したnameを割り当てる。
- [ ] context の通信操作に適切な cleanup/cancel handle を返す。
- [ ] drop detector contextへdetector-scopedな`signal`、event callback用`guard()`、background task用`run()`を追加し、connection setup contextのresource scopeと統合する。
- [ ] force 系を高レベル `Unipls` の public surface から除き、transport-epoch-boundなprovisioning contextのcapabilityとして共通primitive上に実装する。
- [ ] connecting 中の準備通信が raw open 後、ready 前に動作することを test する。
- [ ] 再接続ごとに session-scoped listener が重複しないことを test する。
- [ ] setup途中のthrow/rejectではそのtransactionで登録済みの同期・非同期disposerをLIFO rollbackし、cleanup errorを診断へ集約する。
- [ ] setup transactionを親scopeから分離した子`ResourceScope`として扱い、rollback時に当該transactionのresourceだけを破棄する。
- [ ] rollback中にdisposerが失敗しても残りをLIFO順にすべて一度ずつ試行し、元のsetup errorをattempt failureの主要なcauseとして維持する。cleanup errorで置換したり暗黙に`AggregateError`化しない。
- [ ] drop detector setupをready前のconnection setup transactionへ含め、failureをattempt causeとしてreconnectorへ渡す。

完了条件:

- connection-scoped resourceはtransport epoch終了時、session-scoped resourceはsession終了時に破棄される。
- provisioning failure/abort 後に通常 operation が未準備 connection へ流れない。
- `cast`、`request`、`subscribe` の準備通信に barrier の非対称性がない。
- session setupは成功後に同じsessionで再実行されず、connection setupは各epochでちょうど一度成功する。
- cleanupの成功可否にかかわらずscope内の全disposerが一度ずつ試行され、setup/close/dropの本来のoutcomeが維持される。
- 競合するdrop/close/rollbackが同じscopeをdisposeしても一つのcleanup Promiseへ収束し、dispose開始後にresourceを追加できない。

適用する決定: D1、D8、D9。

依存: Task 9。

#### Task 11: drop detector の lifecycle を堅牢化する

- [ ] detector setup を transactional にする。
- [ ] detectorへ任意の明示`name`を追加し、0始まりのregistration indexと合わせたfrozen identityを登録時に生成する。明示nameのinstance内重複をsession開始前に拒否する。
- [ ] 途中の setup failure で、登録済み disposer を逆順に実行する。
- [ ] detector/resource cleanupをD9のscope-owned disposer stackへ統合し、async cleanupとcleanup error後の継続をtestする。
- [ ] disposerを冪等にし、drop/close/provisioning failure/transport epoch交代で一度だけ実行する。
- [ ] detector disposerの同期throw/非同期rejectを個別に捕捉し、後続disposerを止めず、同じdisposerを競合する終了経路から再試行しない。
- [ ] detector runtime callback/taskを`guard()`/`run()`のerror boundary内で実行し、同期throw/非同期reject時は当該detectorだけをabort・停止してconnection-scoped diagnosticへ渡す。
- [ ] `guard()`の戻り値からerrorやrejected Promiseをhostへ漏らさず、`run()` taskでもunhandled rejectionを発生させない。
- [ ] detector runtime failureで他detectorとconnectionを継続し、自動dropしないことをcontract testする。
- [ ] runtime failure diagnosticへdetector identityと`guard`/`run` boundaryを含め、detector由来dropでは同じidentityをcanonical `UniplsDrop.source`へ保持する。
- [ ] epoch終了による正常なsignal abort、runtime failure、drop/close競合を共通settle gateで一度だけ処理し、built-in detectorが監督外callback/taskを作らないことをtestする。
- [ ] heartbeat の abort listener を timer 完了時にも解除する。
- [ ] runtime非依存な`HeartbeatDropDetector`をrootから、browser固有な`NetworkDropDetector`を`unipls/browser`から公開し、root importが`window`やbrowser moduleへ到達しないことをtestする。

完了条件:

- detector の部分失敗と例外で resource leak が起きない。
- 長時間 heartbeat で abort listener が増え続けない。
- detector cleanup failureがconnectionのdrop/close outcomeを上書きせず、全cleanupの試行が完了する。
- supervised callback/task failureで当該detectorだけが停止し、hostへのthrow、unhandled rejection、自動dropが発生しない。
- 複数detectorの同時反応と後発socket closeでもdrop/recoveryは一度だけであり、最初のdetector identityを観測できる。

適用する決定: D9、D11、D12。

依存: Task 10。

### Phase 4: 公開契約と配布物

#### Task 12: public event、error、診断モデルを確定する

- [ ] 任意文字列を許す public event 型を有限 event map に置き換える。
- [ ] event payload から mutable internal session object を除く。
- [ ] lifecycle event の previous/current と extension context に、D2 の frozen snapshot または用途別に絞った readonly view だけを渡す。
- [ ] session/connection/attempt/close metadata を immutable snapshot にする。
- [ ] `UniplsDrop`をreconnector、lifecycle、operation error、診断eventで共有し、生の`CloseEvent`やsocketを公開しない。
- [ ] detector identityをregistration indexと任意の一意nameで型付けし、detector failure diagnosticとdetector由来`UniplsDrop.source`で同じfrozen recordを共有する。
- [ ] rootのdomain errorをD11の6種類へ整理し、`UniplsOpenError`と`UniplsDroppedError`へattempt/drop outcomeと元のcauseを保持する。
- [ ] domain error に安定した `name`、必要な `cause` と metadata を与える。
- [ ] extension/callback error の診断経路を実装し、callback同期throwをmessage本体を含まない`stream-callback-failed` variantとして公開する。
- [ ] finiteなdiagnostic unionとsession/connection/operation scopeを公開し、deserialization failureにはmessage sequenceとraw inputのkind/sizeだけを含める。
- [ ] selector/terminator failureをoperation-scopedな`message-predicate-failed` variantとして公開し、message本体やconnection/message sequenceを含めない。
- [ ] lossy bufferによるmessage破棄をoperation-scopedな`stream-message-dropped` warningとして一件ずつ通知し、message本体を含めず、overflow `"error"`では重複通知しない。
- [ ] reconnector failureをsession-scoped diagnosticとして一度だけ通知し、contextとfailure pointを含め、terminal errorそのものと元のcauseを各consumer outcomeと同じobject identityで共有する。
- [ ] detector runtime failureをidentityと監督boundary付きのconnection-scoped `drop-detector-failed` diagnosticとして通知し、setup failureはattempt error側だけへ流す。
- [ ] cleanup failureを所有scope、発生時刻、元のerror、任意name、`defer`/`setup-return`/`internal`の登録元を持つ`resource-cleanup-failed` diagnosticとして一件ずつ通知し、resource object、disposer function、登録順indexは公開しない。
- [ ] cleanup diagnosticは元のsetup/close/drop/operation outcomeを変更せず、`close()`やsubscriptionの`closed`をrejectさせない。cleanup完了は全disposerを成功・失敗にかかわらず一度ずつ試行した時点とする。
- [ ] diagnosticを内部処理確定後のmicrotaskでdispatchし、listener throwをfan-out/lifecycleから隔離する。listener不在時にconsoleへ出力しない。
- [ ] Promise/AsyncIteratorのerrorとstream finalizationの語彙・object identityを揃え、failure variantの`error`に同じ値を保持する。
- [ ] streamのcanonicalな終了通知を非rejectingな`closed`とfrozen finalization unionにする。legacy終了callbackを明示的に残す判断をした場合だけ、`closed`から一方向に通知するadapterとして定義する。

完了条件:

- 存在しない event 名が型検査で拒否される。
- public payload を変更しても内部 state が変わらない。
- lifecycle snapshot が runtime でも frozen され、phase ごとの型 narrowing が機能する。
- socket 固有 error に依存せず通常 operation の失敗を処理できる。
- stream終了結果を`ok`だけで正常・異常に分岐でき、`reason`で個別原因へさらにnarrowingできる。
- disposerが失敗しても同じscopeの後続cleanupと本来のterminal通知が完了し、cleanup failureは診断から観測できる。

適用する決定: D2、D5、D10、D11。

依存: Task 11。

#### Task 13: root public API と型 export を整理する

- [ ] `Unipls` の全 public signature に現れる型を export する。
- [ ] provisioner、reconnector、drop detector、recovery、subscription の拡張契約を export する。
- [ ] rootからruntime非依存な`HeartbeatDropDetector`だけをexportし、`NetworkDropDetector`をroot declarationから除く。
- [ ] subscription handleと`ok`/`reason`でnarrowing可能なfinalization unionをrootからexportし、AsyncIterable adapterのbuffer/overflow policyもpublic typeにする。
- [ ] `UniplsSocket`、socket error、close code、低レベル固有型を root から `unipls/socket` へ移す。
- [ ] WebSocket注入用のconstructor/socket/eventをDOM具象型に依存しない最小structural interfaceとして`unipls/socket`からexportし、rootは必要な型だけを参照する。
- [ ] `castForce` / `requestForce` / `subscribeForce` を高レベル `Unipls` の public declaration から除く。
- [ ] public declaration に private/internal 型が漏れていないことを API test で確認する。
- [ ] public declarationが`Symbol.dispose`/`Symbol.asyncDispose`や`esnext.disposable`型libraryを要求せず、`Unipls`から現行の`Symbol.asyncDispose`を除去する。
- [ ] breaking change を移行メモに記録する。
- [ ] testの`await using`を`try/finally`と明示的な`await close()`へ置き換え、cleanup完了を省略しない共通test helperを用意する。

完了条件:

- consumer が deep import なしで全 public API を型付けできる。
- root の export 一覧がコアコンセプトの公開境界と一致する。
- root の public declaration に `UniplsSocket` や低レベル固有型が漏れていない。
- DOM型libraryを含めないNode/Deno/Bun consumerでもpublic declarationを型検査できる。

適用する決定: D1、D7、D10、D11。

依存: Task 12。

#### Task 14: package export と consumer smoke test を完成させる

- [ ] `package.json` に runtime/types の root export を設定する。
- [ ] `unipls/socket` の runtime/types subpath export を設定する。
- [ ] `unipls/browser`のruntime/types subpath exportを設定し、`NetworkDropDetector`と将来のbrowser固有adapterだけを公開する。
- [ ] description、keywords、files、engines/runtime 前提を整える。
- [ ] `engines.node`を`>=22.4.0`に設定し、Deno `>=2.0.0`、Bun `>=1.2.0`、browser rolling policy、ES2022 targetをpackage metadataとsupport documentへ明記する。
- [ ] tarball を作り、隔離した fixture project へ install する test を追加する。
- [ ] fixture で `unipls` と `unipls/socket` の ESM import、型検査、最小接続をそれぞれ検証する。
- [ ] Browser、Node.js、Deno、Bunそれぞれでroot APIと`unipls/socket`のconsumer smoke testを実行し、最小接続とclose/drop cleanupまで検証する。
- [ ] browser fixtureで`unipls/browser`を検証し、Node/Deno/Bun fixtureではroot importがbrowser固有moduleを評価せず`window`へアクセスしないことを検証する。
- [ ] global WebSocketの既定利用、注入constructorの優先、global欠落時の同期的な構成error、module importだけではglobalへアクセスしないことをtestする。
- [ ] operationのuser/scope/timeout signal合成がnative `AbortSignal.any`を使い、最初の`reason`を同一objectのままresultへ伝えることを全runtimeでtestする。
- [ ] source や monorepo alias がなくても動作することを確認する。

完了条件:

- `import { Unipls } from "unipls"` が配布物から実行・型検査できる。
- `import { UniplsSocket } from "unipls/socket"` が配布物から実行・型検査できる。
- `import { NetworkDropDetector } from "unipls/browser"`がbrowser fixtureで実行・型検査でき、rootからはimportできない。
- 公開した最低version policyに含まれるBrowser、Node.js、Deno、Bunで同じtarballが動作する。
- 最低versionと最新stableの両方でconsumer smoke testが通る。
- export されていない deep path は意図どおり拒否される。
- Task 1 の CI に consumer smoke test が追加される。

適用する決定: D1、D12。

依存: Task 13。

### Phase 5: optional ergonomics と release 確認

#### Task 15: correlation helper の要否を検証する（optional）

- [ ] 同時 request/subscription 数に対する selector fan-out の負荷を計測する。
- [ ] request ID/topic を使う実利用例から重複実装を収集する。
- [ ] 必要なら key extractor/router を selector 上の opt-in helper として設計する。
- [ ] keyed dispatcherはkey bucketをcandidate reductionにだけ使い、bucket内の複数operationへfan-outして最終selectorを共通primitiveで評価する。
- [ ] helperがTask 7のinternal dispatcher境界を再利用し、timeout、drop/recovery、cleanup、diagnosticを独自実装しないことを確認する。
- [ ] public API候補としてcorrelated viewとoperationごとのroute hintを比較し、key欠落、抽出失敗、重複key、recovery中のregistration semanticsを決定する。
- [ ] core の broadcast semantics と特定 message envelope 非依存性を維持する。

完了条件:

- helper を追加する場合は、測定または利用例で必要性を説明できる。
- 必要性がなければ、非採用理由を記録して終了する。
- helper追加時にも既存selector-only operationと同じmessageを共有でき、初期releaseのbroadcast semanticsを破壊しない。

適用する決定: D13。

依存: Task 14。初期 release の blocker にはしない。

#### Task 16: release candidate を総合検証する

- [ ] behavior matrix の全行が contract test に対応しているか監査する。
- [ ] 公開パッケージの契約testが`*.spec.ts`、それ以外が`*.test.ts`に分類され、公開contract testがinternal moduleへ依存していないことを監査する。
- [ ] 新しいsource/testが`tests/reference/**`をimportせず、referenceのassertionを現仕様の根拠として引用していないことを監査する。
- [ ] format、lint、型検査、unit/contract test、build、consumer smoke test を実行する。
- [ ] timer、listener、AbortSignal、detector、reconnector cleanup の leak test を実行する。
- [ ] supported runtime ごとの最小 integration test を実行する。
- [ ] `overview.md`、public API docs、migration note を実装と照合する。
- [ ] `plan.md` と本書の完了項目を更新し、残課題を次期 milestone へ移す。

完了条件:

- P0/P1 の未完了項目がない。
- public contract と package artifact の双方を consumer 視点で検証済みである。
- optional task を除き、未決の設計判断がない。

適用する決定: D1〜D13すべて。

依存: Task 14。Task 15 とは独立。

## 依存関係の要約

```text
Task 0 → Task 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 ─┬→ 14 → 16
Task 1 ──────────────────────────────────────────────────────────────┘

Task 14 → Task 15 (optional)
```

Task 1 は早期に独立して進められます。Task 3 以降は lifecycle の前提を共有するため、原則として順番を入れ替えません。Task 7〜9 と Task 10 で公開 API が変わり得るため、package exports を先に固定しないことが重要です。
