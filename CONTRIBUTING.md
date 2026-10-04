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

## Releases

When changesets are merged into `main`, the Release workflow creates or updates the `chore: release packages` pull request with version and changelog updates. Merging that pull request into `main` runs `pnpm release`, which runs `changeset publish`. The `prepack` lifecycle script runs `pnpm build` before packing or publishing the package.

Following the [official Changesets Action workflow](https://github.com/changesets/action/blob/v1/README.md#with-publishing), Changesets publishes unpublished versions to npm and creates local tags. The Action pushes those tags and creates GitHub Releases using the corresponding `CHANGELOG.md` entries. This pnpm workspace uses tags such as `unipls@0.3.0`. Versions already published to npm are skipped.
