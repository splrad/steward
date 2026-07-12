# CLI

The cross-platform command surface is `init`, `activate`, `doctor`, and
`upgrade`. `doctor`, all three explicit `init` stages, and two-phase `activate`
are implemented; `upgrade` remains a later lifecycle unit.

```text
steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]
steward init --dry-run --spec FILE [--target DIRECTORY] [--json]
steward init --preflight --repo OWNER/REPOSITORY --spec FILE [--json]
steward init --apply --repo OWNER/REPOSITORY --spec FILE
steward activate --repo OWNER/REPOSITORY --pr NUMBER
```

`doctor` and preflight are read-only. Dry-run is a deterministic local generator
that never writes its target. Apply requires repository administrator access,
verifiable GitHub App installation scope, an interactive TTY, and an explicit
confirmation after rendering the complete non-sensitive plan. It only fills
missing repository Secrets and the App client-ID Variable, creates one exact
`steward/init` commit and ref, and opens a PR; it never updates the default
branch. Secret values are hidden, bounded, sealed-box encrypted before GitHub
transport, redacted from errors, and best-effort zeroed after their scoped use.

Activate is intentionally two-phase and interactive. The first invocation
validates the current default-branch Manifest, Matrix caller, administrator
access, App installation, open PR, and current head. If no versioned Matrix
Check from that App matches the repository, PR, head, and config digest, it
dispatches one full Matrix run and exits without reading or writing rulesets.
This successful phase-1 dispatch exits `0`; run the same command again after
the App Check appears. The second invocation
either recognizes an already active exact rule or renders a ruleset plan and
requires confirmation. It replaces only the exact legacy Main/Copilot checks,
preserves every other required check and rule, and re-reads the full plan before
one ruleset create or update. With no Steward-owned ruleset, it creates a
dedicated `SPLRAD Steward` ruleset instead of guessing which project policy to
edit. Ambiguous or inherited Steward rules fail closed.

Exit code `0` is success, `1` is a failed check, action-required stop, or user
cancellation, and `2` is usage, authentication, unverifiable evidence, or a
runtime failure. A partially completed apply reports durable resource names and
is safe to rerun only when the existing branch and PR still match the exact
confirmed initialization state.
