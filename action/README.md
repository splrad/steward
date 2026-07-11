# Steward Action

The bundled Node 24 Action is the only execution boundary between reusable workflows and Steward policy/GitHub adapters. Consumers pin the repository to a complete commit SHA and pass an explicit token for every operation except `version`.

Supported operations:

- `version`: report the bundled development/release version without GitHub access;
- `governance-request-copilot`: request the official Copilot reviewer with a caller-supplied entitled user token;
- `governance-auto-approve`: submit the marked core-maintainer approval when all identified contributors satisfy the default-branch Manifest;
- `governance-main`: evaluate current-head authorization, request missing core reviews, update the App Check, and converge the aggregate blocking comment;
- `governance-copilot`: evaluate current-head Copilot reviews/threads, update the App Check, and converge the aggregate blocking comment;
- `matrix`: evaluate Steward-owned targets, complete proxies, dispatch or rerun one-shot repairs, and update the Matrix App Check.

`matrix` is the only operation whose workflow may grant `Actions: write`. The Action does not read token fallbacks from process environment. Repository identity, default branch, pull request state, head SHA, Manifest, Checks, reviews, threads, jobs, and workflow evidence are re-read from GitHub. Workflow inputs carry only stable runtime facts (`pr-number`, `head-sha`, result/mode/scope); labels, paths, maintainers, Check names, workflow files, and other policy cannot be injected through Action inputs.

Reusable workflows must serialize `governance-main` and `governance-copilot` for the same PR head because both converge source families in one aggregate comment. Matrix remains independently serialized by its workflow concurrency key.

GitHub Enterprise Server callers use the platform-provided REST URL and the Action derives the distinct `/api/graphql` base while retaining independent transport confinement.
