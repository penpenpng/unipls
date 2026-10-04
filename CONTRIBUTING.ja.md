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
