# uniplsのテスト構成

このdirectoryには、source tree上の挙動だけでなく、利用者が受け取る型宣言と配布packageを検証するtestも置きます。公開契約の期待値は`docs/v1/ja/concepts.md`と`docs/dev/tasks.md`から導き、既存実装だけを根拠に新しい契約を固定しません。

## directoryの役割

| path                | 役割                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec/**/*.spec.ts` | `unipls`、`unipls/socket`、`unipls/browser`の公開entry pointから観測できる挙動をblack-boxで検証します。lifecycle、operation、event、error、resource cleanupなど、利用者との契約を扱います。       |
| `unit/**/*.test.ts` | 内部resource、組み込みextension、test harnessなど、公開契約ではない実装単位を検証します。ここで観測する内部構造は互換性を保証しません。                                                           |
| `api/`              | build後のpackage名importをTypeScriptで型検査します。`public-api.ts`は実行するtestではなく、compileに成功すること自体がtestです。DOM libraryなしのconsumerでも公開型を利用できることを確認します。 |
| `package/`          | packageをtarball化して一時directoryへinstallし、exports、同梱file、Node.js上のruntime behavior、consumer側の型検査、deep importの拒否を検証します。`fixture/`はその隔離consumerです。             |
| `runtime/`          | CIのruntime matrixとbrowser smoke testを補助します。tarballをNode.js、Deno、Bun、およびPlaywrightのChromium、Firefox、WebKitから利用します。                                                      |
| `support/`          | WebSocket、extension、時系列を決定的に制御するharnessと共通helperを置きます。production APIではなく、必要な挙動は`unit/`で検証します。                                                            |

`spec`と`unit`はVite+の別projectとして収集されるため、公開仕様の失敗と内部実装の失敗を分けて確認できます。`api`、`package`、`runtime`は目的が異なるため、通常のtest runnerとは別の検査として実行します。

## 実行方法

repository rootから次のcommandを実行します。

```sh
pnpm test
pnpm test:spec
pnpm test:unit
pnpm typecheck
pnpm test:package
pnpm check
```

- `pnpm test`は`spec`と`unit`をまとめて実行します。
- `pnpm typecheck`はsourceとtestの型検査に加え、buildした型宣言を使って`api/public-api.ts`を検査します。
- `test:package`はbuild、tarball作成、隔離install、Node.js smoke test、consumer型検査を一続きで実行します。
- `pnpm check`はformatとlintを検査します。
- Deno、Bun、browserのversion matrixは`.github/workflows/ci.yml`で実行します。

## testを書くときの規則

- 公開entry pointから観測できる保証は`*.spec.ts`、内部実装だけの保証は`*.test.ts`に書きます。
- `*.spec.ts`からprivate/internal moduleを直接importせず、公開APIまたは`support/`のblack-box harnessを通して観測します。
- 各spec testには、利用者が書く具体的なcodeと保証される結果をMarkdown形式のJSDocで示します。
- test名は「前提・操作・期待結果」が分かる日本語で書き、英語のAPI用語との境界には空白を入れます。
- JSDocを利用者視点の契約説明とし、test本文のcommentは外部要因を示す`// !`またはcodeだけでは分からない理由に限定します。test名やcodeの言い換えは書きません。
- 一つのspecに異なる関心事を混在させず、仕様の階層はfile名と`describe`で表します。共通化する場合は、protocol上重要な操作やassertionを隠さないdomain固有のhelperにします。
- peer切断、timeout到達、signal abortなど、codeから直接は見えない外部要因は、発生させる行に`// !` commentを付けます。
- networkや実時間に依存させず、controlled WebSocket、hook、fake timerを使ってeventの順序と競合を決定的にします。
- `flushMicrotasks()`は、libraryが明示的にmicrotaskへ予約した処理を観測する場合だけ使います。呼出回数に意味を持たせず、可能なら観測可能な状態やPromiseを待ちます。
- test終了時は`close()`、`unsubscribe()`、timer復元などを明示的に完了させ、後続testへlistenerや非同期処理を残しません。

公開契約を変更する場合は、先に対応するspec testで期待値を示し、同じ変更内で実装、型検査、package consumerまでgreenにします。
