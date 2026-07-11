# Reusable workflow contracts

Steward reusable workflows are called from thin workflows in each consumer repository. GitHub associates the workflow run, `github` context, event payload, and `GITHUB_TOKEN` with that caller. The called workflow cannot elevate caller token permissions and does not replace the caller's trigger, file identity, or `run-name`.

Consumer callers must therefore:

- pin the Steward reusable workflow to a complete commit SHA;
- grant only `contents: read` to the calling job and pass named secrets explicitly rather than using `secrets: inherit`;
- derive `pr_number`, `head_sha`, event name, and event action only from the native event payload or a previously validated relay payload;
- keep the Classification caller at `.github/workflows/pr-classification.yml` with `run-name: "PR Validation Target #<PR> / <40-character-head-SHA> / classification"`;
- keep the Governance caller at `.github/workflows/pr-governance.yml` with `run-name: "PR Validation Target #<PR> / <40-character-head-SHA> / <scope>"`;
- keep the Review Signal caller at `.github/workflows/pr-review-signal.yml` with `run-name: "PR Review Signal #<PR> / <40-character-head-SHA> / <source-event> / <source-action>"`;
- keep Matrix as the only caller of `.github/workflows/pr-validation-matrix.yml` that receives the App private key used to request `Actions: write` on an installation token.

The Governance called workflow reads the default-branch Manifest before human-token jobs. Disabled features skip the corresponding Copilot request or automatic approval, but their platform Gate operation still runs once to remove stale Check/comment state. Missing optional human secrets fail explicitly only when the relevant feature and scope require them.

The Classification called workflow mints one repository installation token with `Contents: read` plus `Checks`, `Issues`, and `Pull requests: write`. It does not checkout caller code, receive a human token, or receive label/path/Check policy as input. A disabled Classification feature returns `ignored` without creating a custom Check or trusting editable PR metadata to remove labels.

These caller requirements are security contracts, not project policy. Check names, workflow target catalog, maintainer identity, labels, paths, and account choices remain in Steward or the default-branch Manifest and are not caller inputs.
