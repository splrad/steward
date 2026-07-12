# SPLRAD Steward

SPLRAD Steward is shared automation for pull requests, releases, and repository governance across SPLRAD projects.

The project is being extracted from a production-tested, event-driven workflow. Its public interfaces are designed around three constraints:

- repositories keep only thin event-entry workflows, one versioned manifest, and optional release adapters;
- every state change is driven by a real GitHub event, with no scheduled refresh, sleep, or polling;
- consumers pin Steward workflows and the bundled Action to a complete commit SHA.

## Status

The repository contains the versioned Manifest contract, shared policy and GitHub integration layers, bundled Actions, reusable workflows for classification, governance, review signal, validation matrix, and releases, the multi-repository webhook relay, canonical thin callers, and the first read-only CLI surfaces. These components have been validated in `splrad/steward-sandbox`; production consumer migration remains a separate controlled stage.

## CLI

Build the reproducible CLI bundle before running it locally:

```console
npm run build:cli
node packages/cli/dist/index.js doctor --repo OWNER/REPOSITORY
node packages/cli/dist/index.js init --dry-run --spec steward-init.json --target PATH
node packages/cli/dist/index.js init --preflight --repo OWNER/REPOSITORY --spec steward-init.json
```

`doctor` is read-only and requires `GH_TOKEN` or `GITHUB_TOKEN`. `init --dry-run` remains a pure local planner: its strict JSON spec contains one complete Steward commit SHA, a full Manifest, and an optional Node release-adapter declaration. It reads the target only to classify each generated file as `create`, `unchanged`, or `conflict`; it never writes files, calls GitHub, accepts Secret values, or changes a default branch. A conflict makes the command fail closed. Release generation emits an intentionally failing adapter skeleton that must be implemented before applying the plan. The legacy `prAutomation` and DCO advisory surfaces are not generated yet and are rejected when enabled.

`init --preflight` is a separate read-only network check using the same non-secret spec. It verifies the target account installation, required App permissions, and—when the installation is limited to selected repositories—the target repository membership. A missing installation stops with the App's new-install URL; a repository missing from an existing installation stops with that installation's GitHub configuration URL. An unverifiable selected scope is reported as unknown and never treated as installed. Organization discovery requires an organization administrator token with `read:org`. GitHub's selected-repository and personal-installation endpoints require a compatible GitHub App user access token or personal access token; a normal GitHub CLI OAuth token is rejected even when it has `read:user`. The preflight issues GET requests only and does not configure the App or repository.

The CLI now has the target-repository credential-input foundation needed by the future mutating `init` stage, but it is deliberately not exposed as a standalone command. When that stage is wired, target Secret values will be accepted only from a hidden interactive TTY—not specs, arguments, environment variables, files, or piped input; the existing `GH_TOKEN`/`GITHUB_TOKEN` API-authentication contract for `doctor` and preflight is unchanged. PATs use bounded single-line input; the GitHub App RSA private key uses bounded multiline input terminated by a line containing only `.`. Cancellation and EOF fail closed, terminal state is restored, retained buffers are zeroed after their scoped consumer finishes, and top-level errors redact private-key, GitHub-token, JWT, and authorization-header shapes. This foundation does not yet write GitHub Secrets, create a branch or PR, or mutate repository settings.

## Repository layout

- `action/`: bundled JavaScript Action published directly from a pinned commit.
- `packages/`: core policy, manifest, GitHub, relay, and CLI module boundaries.
- `schema/`: versioned project manifest schema.
- `templates/`: thin workflows, manifest examples, and release-adapter templates.
- `tests/`: contracts, fixtures, and static policy checks.
- `docs/migration/`: source-to-Steward compatibility and migration records.
- `docs/reusable-workflows.md`: caller/called workflow trust, identity, permission, and run-name contracts.

## Development

Use the Node version in `.node-version`.

```console
npm ci
npm test
npm run typecheck
npm run verify
```

No generated `dist` change is accepted unless it is reproducible from the committed source and lockfile.

## License

Licensed under the Apache License 2.0. See `LICENSE`.
