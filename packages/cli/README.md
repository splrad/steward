# CLI

The cross-platform command surface is `init`, `activate`, `doctor`, and
`upgrade`. All four lifecycle surfaces are implemented.

```text
steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]
steward init --dry-run --spec FILE [--target DIRECTORY] [--json]
steward init --preflight --repo OWNER/REPOSITORY --spec FILE [--json]
steward init --apply --repo OWNER/REPOSITORY --spec FILE
steward activate --repo OWNER/REPOSITORY --pr NUMBER
steward upgrade --repo OWNER/REPOSITORY --to STEWARD_SHA
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

Upgrade is interactive and accepts only a complete target commit SHA in the
canonical `splrad/steward` repository. It verifies the target is not older or
diverged from any current pin, reads target templates at that immutable commit,
and replaces a managed caller or Dependabot file only when its current content
is provably the prior Steward-generated template. The Manifest schema URL and
supported schemaVersion are migrated while project configuration is retained.
The release adapter is read into the confirmation fingerprint when it has a
repository path and is never included in the write set. After confirmation the
entire plan is re-read before creating one `steward/upgrade` commit and PR; the
default branch, credentials, App, rulesets, and unrelated files are untouched.
The current CLI supports the explicit v1-to-v1 migration surface and fails
closed for unsupported source or target schema versions.

DCO Advisory is a managed non-required surface: init and upgrade generate its
thin caller together with Matrix, and doctor verifies its immutable pin. Until
the shared PR Automation runtime is present, doctor reports that feature as a
failure and upgrade refuses to leave it unmanaged. This prevents a partial
lifecycle plan from being presented as a safe repository upgrade.

Exit code `0` is success, `1` is a failed check, action-required stop, or user
cancellation, and `2` is usage, authentication, unverifiable evidence, or a
runtime failure. A partially completed init apply or upgrade reports durable
resource names and is safe to rerun only when the existing branch and PR still
match the exact confirmed plan.
