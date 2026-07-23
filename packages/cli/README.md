# CLI

The public cross-platform command surface is `init`, `doctor`, and `upgrade`.

```text
steward doctor --repo OWNER/REPOSITORY [--pr NUMBER] [--json]
steward init --dry-run --spec FILE [--target DIRECTORY] [--json]
steward init --preflight --repo OWNER/REPOSITORY --spec FILE [--json]
steward init --apply --repo OWNER/REPOSITORY --spec FILE
steward upgrade --repo OWNER/REPOSITORY --to STEWARD_SHA
```

The Actions-first `activate` implementation, adoption parser, and adoption
source verifier remain historical test fixtures only. They are not reachable
from the public CLI, and adoption profiles are excluded from the CLI bundle.
Public init specs reject `adoption` before reading a target. Organization-native
activation will first use the shared conformance verifier, then require an
organization owner to perform the `steward_state` transition in GitHub's owner
control plane. A future centralized owner-bound lifecycle identity may automate
that transition only after consumer repositories no longer receive the runtime
App private key. A repository that still stores that private key or its legacy
callers must never enter `active`, because GitHub rulesets validate the required
Check name and App source, not Steward's `external_id`. Until that replacement
lands, this CLI has no public activation command.

`doctor` and preflight are read-only. Doctor reads repository facts with
`GH_TOKEN`/`GITHUB_TOKEN` and accepts a separate organization-owner diagnostic
identity through `STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN`; selected-installation
membership can additionally use `STEWARD_APP_USER_TOKEN`. It verifies the
default-branch Manifest, organization properties and ruleset definition/
applicable/effective layers, Team access, App installation permissions/events,
organization Actions policy, current-head App Check identity, and injectable
central runtime evidence. Missing permissions, stale evidence, unsupported
response fields, unresolved live Team identity, unverified owner observations,
and the pending Actions actor/event inventory remain `unknown` rather than being
reported as absent or healthy.

Dry-run is a deterministic local generator
that never writes its target. Apply requires repository administrator access,
verifiable GitHub App installation scope, an interactive TTY, and an explicit
confirmation after rendering the complete non-sensitive plan. It only fills
missing repository Secrets and the App client-ID Variable, creates one exact
`steward/init` commit and ref, and opens a PR; it never updates the default
branch. Secret values are hidden, bounded, sealed-box encrypted before GitHub
transport, redacted from errors, and best-effort zeroed after their scoped use.

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

DCO Advisory is a managed non-required transitional surface: init and upgrade generate its
thin caller together with Matrix.
PR Automation is also fully managed: its caller routes only live non-default
human branch pushes, while the shared runtime reads bounded GitHub API compare
evidence and never checks out or executes consumer-branch code. It requires the
same App private key and client-ID Variable as the other App-backed surfaces;
Copilot CLI credentials are not part of the current deterministic contract.
Governance or Copilot Review also derives a managed post-close Cleanup caller;
it is not a separate project policy switch. Cleanup removes only Steward
App-owned temporary comments and writes a durable notice only for merged PRs.

Exit code `0` is success, `1` is a failed check, action-required stop, or user
cancellation, and `2` is usage, authentication, unverifiable evidence, or a
runtime failure. A partially completed init apply or upgrade reports durable
resource names and is safe to rerun only when the existing branch and PR still
match the exact confirmed plan.
