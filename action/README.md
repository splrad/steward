# Steward Action

The bundled Node 24 Action is the only execution boundary between reusable workflows and Steward policy/GitHub adapters. Consumers pin the repository to a complete commit SHA. Operations that read GitHub pass an explicit platform token; `version` and the filesystem-only `release-adapter` do not. Human review mutations use a second, operation-scoped token and never provide the trusted repository/Manifest context.

Supported operations:

- `version`: report the bundled development/release version without GitHub access;
- `classification`: evaluate the current PR from the default-branch Manifest, converge managed labels and hidden metadata, and update the versioned App Check;
- `governance-preflight`: validate the trusted PR context and expose the default-branch Governance/Copilot feature switches without mutation;
- `governance-request-copilot`: request the official Copilot reviewer with a caller-supplied entitled user token;
- `governance-auto-approve`: submit the marked core-maintainer approval when all identified contributors satisfy the default-branch Manifest;
- `governance-main`: evaluate current-head authorization, request missing core reviews, update the App Check, and converge the aggregate blocking comment;
- `governance-copilot`: evaluate current-head Copilot reviews/threads, update the App Check, and converge the aggregate blocking comment;
- `matrix`: evaluate Steward-owned targets, complete proxies, dispatch or rerun one-shot repairs, and update the Matrix App Check.
- `release-preflight`: validate a live merged default-branch pull request against its trusted close event and default-branch Manifest, then expose the trigger decision and adapter execution facts;
- `release-adapter`: run either the `plan` or `build` phase of the preflight-selected project adapter without a shell in an isolated runner-temporary directory; the build phase inventories, hashes, and validates its assets;
- `release-status`: confirm a real Git tag and every visible published/draft Release state before build, skipping an identical completed publication and failing closed on partial or conflicting state.

`matrix` is the only operation whose workflow may grant `Actions: write`. The Action does not read token fallbacks from process environment. `github-token` validates repository identity, default branch, pull request state, relevant SHA, and Manifest before any GitHub-backed operation; `mutation-token` is required only for `governance-request-copilot` and `governance-auto-approve`, and is confined to the user-attributed review mutation client. Governance workflow inputs carry only stable runtime facts (`pr-number`, `head-sha`, result/mode/scope). Release adapter command and runner values come from `release-preflight` after loading the default-branch Manifest. `release-status` runs between adapter `plan` and `build`, verifies a real tag ref before resolving its commit, and never treats a same-named branch as a tag. Labels, paths, maintainers, Check names, workflow files, and other policy cannot be supplied by a consumer caller.

Reusable workflows must serialize `governance-main` and `governance-copilot` for the same PR head because both converge source families in one aggregate comment. Matrix remains independently serialized by its workflow concurrency key.

When Classification is disabled, the operation returns `ignored` without trusting editable PR-body metadata to remove labels. Enabled runs canonicalize duplicate legacy metadata markers, preserve contributor-authored body text, and retry a repository-label creation race only after confirming the competing label now exists.

GitHub Enterprise Server callers use the platform-provided REST URL and the Action derives the distinct `/api/graphql` base while retaining independent transport confinement.
