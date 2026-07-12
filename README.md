# SPLRAD Steward

SPLRAD Steward is shared automation for pull requests, releases, and repository governance across SPLRAD projects.

The project is being extracted from a production-tested, event-driven workflow. Its public interfaces are designed around three constraints:

- repositories keep only thin event-entry workflows, one versioned manifest, and optional release adapters;
- every state change is driven by a real GitHub event, with no scheduled refresh, sleep, or polling;
- consumers pin Steward workflows and the bundled Action to a complete commit SHA.

## Status

The repository contains the versioned Manifest contract, shared policy and GitHub integration layers, bundled Actions, reusable workflows for classification, governance, review signal, validation matrix, and releases, the multi-repository webhook relay, canonical thin callers, and the first repository-lifecycle CLI surfaces. These components have been validated in `splrad/steward-sandbox`; production consumer migration remains a separate controlled stage.

## CLI

Build the reproducible CLI bundle before running it locally:

```console
npm run build:cli
node packages/cli/dist/index.js doctor --repo OWNER/REPOSITORY
node packages/cli/dist/index.js init --dry-run --spec steward-init.json --target PATH
node packages/cli/dist/index.js init --preflight --repo OWNER/REPOSITORY --spec steward-init.json
node packages/cli/dist/index.js init --apply --repo OWNER/REPOSITORY --spec steward-init.json
```

`doctor` is read-only and requires `GH_TOKEN` or `GITHUB_TOKEN`. `init --dry-run` remains a pure local planner: its strict JSON spec contains one complete Steward commit SHA, a full Manifest, and an optional Node release-adapter declaration. It reads the target only to classify each generated file as `create`, `unchanged`, or `conflict`; it never writes files, calls GitHub, accepts Secret values, or changes a default branch. A conflict makes the command fail closed. Release generation emits an intentionally failing adapter skeleton that must be implemented before applying the plan. The legacy `prAutomation` and DCO advisory surfaces are not generated yet and are rejected when enabled.

`init --preflight` is a separate read-only network check using the same non-secret spec. It verifies the target account installation, required App permissions, and—when the installation is limited to selected repositories—the target repository membership. A missing installation stops with the App's new-install URL; a repository missing from an existing installation stops with that installation's GitHub configuration URL. An unverifiable selected scope is reported as unknown and never treated as installed. Organization discovery requires an organization administrator token with `read:org`. GitHub's selected-repository and personal-installation endpoints require a compatible GitHub App user access token or personal access token; a normal GitHub CLI OAuth token is rejected even when it has `read:user`. The preflight issues GET requests only and does not configure the App or repository.

`init --apply` is the explicit interactive mutation stage. It requires `GH_TOKEN` or `GITHUB_TOKEN` with repository administrator access and the same verifiable App-installation evidence as preflight. Before any mutation it inventories the default branch, required Secret names, the App client-ID Variable, the deterministic `steward/init` branch, and any matching open PR; it then prints a non-sensitive plan and requires TTY confirmation. It fails closed on generated-file conflicts, a mismatched existing Variable, insufficient permission, or a same-named branch that is not the exact generated commit for the current default-branch head. `--json` and non-interactive confirmation are intentionally unsupported.

After confirmation, missing target Secret values are accepted only from a hidden interactive TTY—not specs, arguments, environment variables, files, or piped input. PATs use bounded single-line input; the GitHub App RSA private key uses bounded multiline input terminated by a line containing only `.`. Values are LibSodium sealed-box encrypted with GitHub's current repository public key before transport. The CLI creates one Git tree and commit based on the observed default-branch head, attaches only the new `steward/init` ref, creates missing Secrets without intentionally overwriting existing names, creates the missing client-ID Variable, and finally opens the PR; it never updates the default-branch ref. Cancellation and EOF fail closed, retained buffers are zeroed after use, and errors redact credential shapes and exact held values. If a later mutation fails, the CLI reports completed resource names and a rerun reuses only an exact branch/PR while skipping settings that now exist; it does not delete or roll back credentials whose prior values cannot be recovered.

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
