# コントリビューション

## プルリクエストのタイトル

プルリクエストのタイトルには [Conventional Commits](https://www.conventionalcommits.org/) 形式を使ってください。このライブラリは小規模なため、scope は省略します。

CI はタイトルを検証し、scope が含まれている場合は拒否します。

```text
<type>[!]: <description>
```

`feat`、`fix`、`docs`、`refactor`、`test`、`build`、`ci`、`chore` など、小文字の type を使います。破壊的変更にはコロンの前に `!` を付けてください。

例:

- `feat: add a message selector`
- `fix: preserve pending subscriptions after reconnect`
- `feat!: rename the stream callback option`
- `docs: clarify callback delivery`

## Changeset

新機能、修正、破壊的変更など、パッケージ利用者に影響する変更には changeset を追加してください。パッケージに影響しないドキュメントのみの変更には不要です。

`.changeset/` に一意な小文字の名前を付けた Markdown ファイルを作成し、frontmatter にパッケージ名とリリース種別（`patch`、`minor`、`major`）を記載します。

```md
---
"unipls": minor
---

利用者から見た変更内容を記載します。
```

## リリース

changeset を含む変更を `main` にマージすると、Release ワークフローがバージョンと changelog を更新する `chore: release packages` PR を作成・更新します。この PR を `main` にマージすると、`pnpm release` が `changeset publish` を実行します。パッケージの pack・publish の前に、`prepack` ライフサイクルスクリプトが `pnpm build` を実行します。

[Changesets Action の公式手順](https://github.com/changesets/action/blob/v1/README.md#with-publishing)に従い、Changesets が未公開バージョンを npm に公開してローカルにタグを作成します。Action はそのタグを push し、対応する `CHANGELOG.md` の内容で GitHub Release を作成します。この pnpm ワークスペースでは `unipls@0.3.0` のようなタグ名になります。npm に公開済みのバージョンはスキップします。
