# Contributing

## Pull request titles

Use the [Conventional Commits](https://www.conventionalcommits.org/) format for pull request titles. Omit the scope because this library is small:

CI validates pull request titles and rejects scopes.

```text
<type>[!]: <description>
```

Use a lowercase type such as `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, or `chore`. Mark a breaking change with `!` before the colon.

Examples:

- `feat: add a message selector`
- `fix: preserve pending subscriptions after reconnect`
- `feat!: rename the stream callback option`
- `docs: clarify callback delivery`

## Changesets

Add a changeset for changes that affect package users, including new features, fixes, and breaking changes. Documentation-only changes that do not affect the package do not need one.

Create a Markdown file in `.changeset/` with a unique lowercase name and frontmatter containing the package name and release type (`patch`, `minor`, or `major`):

```md
---
"unipls": minor
---

Describe the user-visible change.
```
