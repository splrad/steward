# Steward Action

The bundled Node 24 Action is the only execution boundary between reusable workflows and Steward policy/GitHub adapters. Consumers pin the repository to a complete commit SHA. Operations that read GitHub pass an explicit platform token; `version` and the filesystem-only `release-adapter` do not. Human review mutations use a second, operation-scoped token and never provide the trusted repository/Manifest context.

Supported operations:

- `version`: report the bundled development/release version without GitHub access;
- `automation`: validate a non-bot branch push against the live repository/default branch, load the trusted Manifest, evaluate bounded compare evidence, and create or converge one default-branch pull request plus its App-owned notice;
- `classification`: evaluate the current PR from the default-branch Manifest, converge managed labels and hidden metadata, and update the versioned App Check;
- `dco-advisory`: evaluate bounded commit authorship and sign-off evidence without becoming merge authority, while removing only App-owned legacy DCO comments;
- `cleanup`: validate a live closed default-branch PR, remove App-owned temporary governance comments, and converge one durable merged notification without reopening or editing the PR;
- `governance-preflight`: validate the trusted PR context and expose the default-branch Governance/Copilot feature switches without mutation;
- `governance-request-copilot`: request the official Copilot reviewer with a caller-supplied entitled user token;
- `governance-auto-approve`: submit the marked core-maintainer approval when all identified contributors satisfy the default-branch Manifest;
- `governance-main`: evaluate current-head authorization, request missing core reviews, update the App Check, and converge the aggregate blocking comment;
- `governance-copilot`: evaluate current-head Copilot reviews/threads, update the App Check, and converge the aggregate blocking comment;
- `matrix`: evaluate Steward-owned targets, complete proxies, dispatch or rerun one-shot repairs, and update the Matrix App Check.
- `release-preflight`: validate a live merged default-branch pull request against its trusted close event and default-branch Manifest, then expose the trigger decision and adapter execution facts;
- `release-adapter`: run either the `plan` or `build` phase of the preflight-selected project adapter without a shell in an isolated runner-temporary directory; the build phase inventories, hashes, and validates its assets;
- `release-status`: confirm a real Git tag and every visible published/draft Release state before build, skipping an identical completed publication and failing closed on partial or conflicting state.
- `release-publish`: revalidate output and remote state, generate notes, create an owned tag and draft Release, upload raw assets through a confined upload endpoint, publish, verify convergence, and complete the Steward Release Check.
- `release-finalize`: revalidate trusted merged-PR facts and write a failed Release Check when a reusable-workflow stage fails before `release-publish` can own reporting; the operation deliberately fails after writing the Check.

`matrix` is the only operation whose workflow may grant `Actions: write`. The Action does not read token fallbacks from process environment. `github-token` validates repository identity, default branch, trusted event identity, relevant SHA, Manifest, and pull request state when the operation has a PR before any GitHub-backed mutation; `mutation-token` is required only for `governance-request-copilot` and `governance-auto-approve`, and is confined to the user-attributed review mutation client. Governance workflow inputs carry only stable runtime facts (`pr-number`, `head-sha`, result/mode/scope). Automation receives only the trusted push source branch and head SHA; it never checks out or executes consumer-branch code, and rebuilds identity metadata from the push actor and GitHub compare commits instead of trusting editable PR-body markers. Release adapter command and runner values come from `release-preflight` after loading the default-branch Manifest. `release-status` runs between adapter `plan` and `build`, verifies a real tag ref before resolving its commit, and never treats a same-named branch as a tag. Labels, paths, maintainers, Check names, workflow files, and other policy cannot be supplied by a consumer caller.

Reusable workflows must serialize `governance-main` and `governance-copilot` for the same PR head because both converge source families in one aggregate comment. Matrix remains independently serialized by its workflow concurrency key.

When Classification is disabled, the operation returns `ignored` without trusting editable PR-body metadata to remove labels. Enabled runs canonicalize duplicate legacy metadata markers, preserve contributor-authored body text, and retry a repository-label creation race only after confirming the competing label now exists.

GitHub Enterprise Server callers use the platform-provided REST URL and the Action derives the distinct `/api/graphql` base while retaining independent transport confinement.
