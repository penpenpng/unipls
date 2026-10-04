# Contributing

## Pull request titles

Use the [Conventional Commits](https://www.conventionalcommits.org/) format for pull request titles:

```text
<type>[optional scope][!]: <description>
```

Use a lowercase type such as `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, or `chore`. Add a concise scope when it helps identify the affected area. Mark a breaking change with `!` before the colon.

Examples:

- `feat(api): add a message selector`
- `fix(reconnect): preserve pending subscriptions`
- `feat(api)!: rename the stream callback option`
- `docs: clarify callback delivery`
