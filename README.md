# SPLRAD Steward

SPLRAD Steward is shared automation for pull requests, releases, and repository governance across SPLRAD projects.

The project is being extracted from a production-tested, event-driven workflow. Its target public interfaces are designed around three constraints:

- ordinary repositories keep one versioned Manifest; only work that must execute project code adds one optional Executor/adapter;
- every state change is driven by a real GitHub event, with no scheduled refresh, sleep, or polling;
- compatible central runtime upgrades use immutable canary/promotion/rollback without changing consumers, while an optional Executor pins trusted code to a complete commit SHA.

## Status

Stages 0–6.5 established and validated the versioned Manifest, pure policy, GitHub adapters, Actions-first operation chain, Relay, lifecycle CLI, release contracts, and Sandbox/blank-repository/mature-repository migration evidence. Stage 6.6 is now migrating that proven behavior to an App-first central event-driven runtime. `packages/control` begins that migration with one runtime-neutral Classification and DCO Advisory kernel used by the existing Action adapter; the remaining reusable workflows, thin callers, and bundled Action surfaces are transitional execution and regression evidence until their central Control slices are complete. Stage 7 consumer migration has not started.

## CLI

Build the reproducible CLI bundle before running it locally:

```console
npm run build:cli
node packages/cli/dist/index.js doctor --repo OWNER/REPOSITORY
node packages/cli/dist/index.js init --dry-run --spec steward-init.json --target PATH
node packages/cli/dist/index.js init --preflight --repo OWNER/REPOSITORY --spec steward-init.json
node packages/cli/dist/index.js init --apply --repo OWNER/REPOSITORY --spec steward-init.json
node packages/cli/dist/index.js activate --repo OWNER/REPOSITORY --pr NUMBER
node packages/cli/dist/index.js upgrade --repo OWNER/REPOSITORY --to STEWARD_SHA
```

`doctor` is read-only and requires `GH_TOKEN` or `GITHUB_TOKEN`. When selected-repository installation proof is required, also set the short-lived `STEWARD_APP_USER_TOKEN` described below; the ordinary GitHub token remains responsible for the rest of the repository inventory. `init --dry-run` remains a pure local planner: its strict JSON spec contains one complete Steward commit SHA, a full Manifest, an optional Node release-adapter declaration, and optionally the ID of a built-in adoption profile. It reads the target only to classify managed files as `create`, `replace`, `delete`, `unchanged`, or `conflict`; it never writes files, calls GitHub, accepts Secret values, or changes a default branch. Without a built-in profile, any different same-path content remains a conflict. A profile can replace or remove only the reviewed paths whose legacy Git blobs match its lowercase SHA-256 digest exactly; the spec cannot provide a path, digest, or arbitrary profile file. Profile values must be verified from the recorded commit with `scripts/verify-adoption-profile-source.mjs`, never calculated from a checkout that may have transformed line endings. Missing removal targets are idempotently unchanged, while any unknown byte fails closed. Release generation emits an intentionally failing adapter skeleton that must be implemented before applying the plan. Enabled PR Automation generates a push-only thin caller that routes live non-default human branches into the shared API-evidence runtime; DCO Advisory is generated as a non-required target together with Matrix whenever enabled.

Generated Dependabot configuration treats each Steward reusable-workflow path as a separate dependency, matching Dependabot Core's current parser model, and groups `splrad/steward/.github/workflows/*` into one update PR. This keeps all generated caller pins on one reviewed Steward version surface without grouping unrelated consumer Actions or Steward's intentionally independent internal runtime pins.

`init --preflight` is a separate read-only network check using the same non-secret spec. It verifies the target account installation, required App permissions, and—when the installation is limited to selected repositories—the target repository membership. A missing installation stops with the App's new-install URL; a repository missing from an existing installation stops with that installation's GitHub configuration URL. An unverifiable selected scope is reported as unknown and never treated as installed. For organization repositories, discovery first uses the organization-owner endpoint and then falls back to the current user's App installations. GitHub's user-installation and selected-repository endpoints accept only a GitHub App user access token; set that short-lived token as `STEWARD_APP_USER_TOKEN`. PATs and normal GitHub CLI OAuth tokens cannot prove selected scope. An organization-owner PAT can prove only an all-repositories installation through the organization endpoint. The preflight issues GET requests only and does not configure the App or repository.

`init --apply` is the explicit interactive mutation stage. It requires `GH_TOKEN` or `GITHUB_TOKEN` with repository administrator, Secrets, Variables, Contents, Pull requests, and Workflows access. When a selected-repositories App installation must be proven, provide a separate short-lived GitHub App user access token as `STEWARD_APP_USER_TOKEN`; it is used only for installation discovery and repository-membership proof, while every inventory and mutation request continues to use `GH_TOKEN`/`GITHUB_TOKEN`. This two-token boundary avoids granting the long-lived runtime App installer-only Secrets, Variables, or Workflows permissions. Before any mutation the CLI inventories the immutable default-branch commit, required Secret names, the App client-ID Variable, the deterministic `steward/init` branch, and any matching open PR; it then prints a non-sensitive plan and requires TTY confirmation. It fails closed on generated/adoption conflicts, a mismatched existing Variable, insufficient permission, or a same-named branch that is not the exact single-parent commit for the current default-branch head. Reuse verifies the complete bounded/paginated added, modified, and removed path set plus every final file state. `--json` and non-interactive confirmation are intentionally unsupported.

After confirmation, missing target Secret values are accepted only from a hidden interactive TTY—not specs, arguments, environment variables, files, or piped input. PATs use bounded single-line input; the GitHub App RSA private key uses bounded multiline input terminated by a line containing only `.`. Values are LibSodium sealed-box encrypted with GitHub's current repository public key before transport. The CLI creates one Git tree and commit based on the observed default-branch head, attaches only the new `steward/init` ref, creates missing Secrets without intentionally overwriting existing names, creates the missing client-ID Variable, and finally opens the PR; it never updates the default-branch ref. Cancellation and EOF fail closed, retained buffers are zeroed after use, and errors redact credential shapes and exact held values. If a later mutation fails, the CLI reports completed resource names and a rerun reuses only an exact branch/PR while skipping settings that now exist; it does not delete or roll back credentials whose prior values cannot be recovered.

`activate --repo OWNER/REPOSITORY --pr NUMBER` is a two-phase interactive command. It requires repository administrator access, a verifiable App installation, an open PR targeting the current default branch, a valid pinned Matrix caller, and `GH_TOKEN` or `GITHUB_TOKEN`. A selected-repositories installation additionally requires `STEWARD_APP_USER_TOKEN`; as with `init --apply`, that token is isolated to installation discovery and membership proof and is never used for dispatch or ruleset access. When the PR head lacks a versioned `PR Validation Matrix Gate` whose App, repository, PR, head, and Manifest digest all match, the command dispatches one full Matrix validation and exits without reading or changing rulesets. After the App Check appears, running the same command again prepares a ruleset change: exact legacy `Main Authorization Gate` and `Copilot Code Review Gate` requirements are removed, the App-bound Matrix Gate is added, and every non-Steward required check, other rule, condition, and bypass actor is preserved. Confirmation is followed by a complete re-read and fingerprint comparison before a single create or update. If no existing ruleset carries Steward markers, the CLI creates a dedicated `SPLRAD Steward` default-branch ruleset rather than choosing an unrelated project policy. Multiple or inherited Steward-bearing rulesets fail closed for manual ownership resolution. `--json`, polling, and non-interactive confirmation are intentionally unsupported.

`upgrade --repo OWNER/REPOSITORY --to STEWARD_SHA` prepares an interactive lifecycle upgrade to one exact 40-character commit in `splrad/steward`. It reads the current default-branch Manifest and every enabled thin caller, verifies that existing managed workflows and Dependabot configuration still match the templates at their pinned Steward versions, and obtains the target schema and templates from the requested immutable commit. The target must be ahead of or identical to every current pin. The current CLI supports the explicit Schema v1-to-v1 migration surface; unsupported source or target schema versions, older/diverged targets, customized managed templates, and any confirmation-time drift fail closed. The resulting `steward/upgrade` commit updates the Manifest schema URL and generated files in a PR without changing the default-branch ref, repository credentials, App configuration, rulesets, or project release adapter. An exact existing branch/PR is reused after partial failure; unrelated same-named state is never reset or overwritten.

## Repository layout

- `action/`: bundled JavaScript Action published directly from a pinned commit.
- `packages/`: core policy, manifest, runtime-neutral control, GitHub, relay, and CLI module boundaries.
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
