# CLI

The cross-platform command surface is `init`, `activate`, `doctor`, and
`upgrade`. `doctor` and the first three explicit `init` stages are implemented;
`activate` and `upgrade` remain later lifecycle units.

```text
steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]
steward init --dry-run --spec FILE [--target DIRECTORY] [--json]
steward init --preflight --repo OWNER/REPOSITORY --spec FILE [--json]
steward init --apply --repo OWNER/REPOSITORY --spec FILE
```

`doctor` and preflight are read-only. Dry-run is a deterministic local generator
that never writes its target. Apply requires repository administrator access,
verifiable GitHub App installation scope, an interactive TTY, and an explicit
confirmation after rendering the complete non-sensitive plan. It only fills
missing repository Secrets and the App client-ID Variable, creates one exact
`steward/init` commit and ref, and opens a PR; it never updates the default
branch. Secret values are hidden, bounded, sealed-box encrypted before GitHub
transport, redacted from errors, and best-effort zeroed after their scoped use.

Exit code `0` is success, `1` is a failed check, action-required stop, or user
cancellation, and `2` is usage, authentication, unverifiable evidence, or a
runtime failure. A partially completed apply reports durable resource names and
is safe to rerun only when the existing branch and PR still match the exact
confirmed initialization state.
