# CLI

The planned cross-platform command surface is `init`, `activate`, `doctor`, and
`upgrade`; only `doctor` is implemented today.

The first implemented command is the read-only diagnostic path:

```text
steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]
```

`doctor` reads the default-branch Manifest, required Secret names and Variables,
thin workflow full-SHA pins and governance-group consistency, organization App installation permissions, a current-head
App Matrix Check, active rulesets, recent Relay dispatch evidence, and the
declared Release adapter file. It never reads Secret values and never sends a
GitHub mutation. Exit codes are `0` for no failures, `1` for diagnostic
failures, and `2` for usage, authentication, or runtime errors.
