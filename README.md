# SPLRAD Steward

SPLRAD Steward is shared automation for pull requests, releases, and repository governance across SPLRAD projects.

The project is being extracted from a production-tested, event-driven workflow. Its target public interfaces are designed around three constraints:

- ordinary repositories keep one versioned Manifest; only work that must execute project code adds one optional Executor/adapter;
- every state change is driven by a real GitHub event, with no scheduled refresh, sleep, or polling;
- compatible central runtime upgrades use immutable canary/promotion/rollback without changing consumers, while an optional Executor pins trusted code to a complete commit SHA.

## Status

Stages 0–6.5 established and validated the versioned Manifest, pure policy, GitHub adapters, Actions-first operation chain, Relay, lifecycle CLI, release contracts, and Sandbox/blank-repository/mature-repository migration evidence. Stage 6.6 is now migrating that proven behavior to an App-first central event-driven runtime. `packages/control` contains the runtime-neutral Classification and DCO Advisory kernel used by the existing Action adapter. The central foundation is split into a bounded HMAC Ingress, an at-least-once Queue plus per-PR SQLite Durable Object Coordinator, and a private versioned Control adapter. Real pull-request operations remain fail-closed, no new Ingress route is live, and the legacy Relay deploy is manual-only until persistent failed-delivery recovery and later Control slices are proven. The remaining reusable workflows, thin callers, and bundled Action surfaces are transitional execution and regression evidence. Stage 7 consumer migration has not started.

## CLI

Build the reproducible CLI bundle before running it locally:

```console
npm run build:cli
node packages/cli/dist/index.js doctor --repo OWNER/REPOSITORY
node packages/cli/dist/index.js init --dry-run --spec steward-init.json --target PATH
node packages/cli/dist/index.js init --preflight --repo OWNER/REPOSITORY --spec steward-init.json
node packages/cli/dist/index.js init --apply --repo OWNER/REPOSITORY --spec steward-init.json
node packages/cli/dist/index.js upgrade --repo OWNER/REPOSITORY --to STEWARD_SHA
```

`doctor` is read-only and requires `GH_TOKEN` or `GITHUB_TOKEN` for repository facts. Provide the independent resident organization identity as `STEWARD_ORGANIZATION_DIAGNOSTIC_TOKEN`; it reads properties, Team, installation, Actions policy, and verifies owner-signed Actions attestations. GitHub currently requires organization `Administration: write` even for Ruleset list/detail GET requests, so complete Ruleset proof uses a separate, short-lived `STEWARD_ORGANIZATION_RULESET_ELEVATED_TOKEN`; Doctor still sends GET only and refuses to reuse either credential as the repository identity or each other. Missing identities leave only their facts `unknown`, so repository-only diagnostics remain useful without silently collapsing credentials. When selected-repository installation proof is required, also set the short-lived `STEWARD_APP_USER_TOKEN` described below. GitHub currently exposes workflow execution protections through its public-preview owner UI rather than a stable policy API. Pass a fresh owner-signed envelope with `--actions-attestation FILE`; Doctor accepts it only when the resident diagnostic token is the same active organization owner and the SSHSIG verifies against that owner's current GitHub SSH signing keys. Inaccessible, malformed, expired, mismatched, or unverified facts remain `unknown` or `permission-denied`: an empty user installation inventory is not authoritative absence, stale runtime/UI evidence is rejected, and the command exits `2` until every required fact can be proven. The standalone CLI does not invent private Control diagnostics or preview-only Actions execution-protection state. `init --dry-run` remains a pure local planner: its strict JSON spec contains one complete Steward commit SHA, a full Manifest, and an optional Node release-adapter declaration. It reads the target only to classify managed files as `create`, `unchanged`, or `conflict`; it never writes files, calls GitHub, accepts Secret values, changes a default branch, or performs legacy migration. Any different same-path content remains a conflict. Release generation emits an intentionally failing adapter skeleton that must be implemented before applying the plan. Enabled PR Automation generates a push-only thin caller that routes live non-default human branches into the shared API-evidence runtime; DCO Advisory is generated as a non-required target together with Matrix whenever enabled.

Generated Dependabot configuration treats each Steward reusable-workflow path as a separate dependency, matching Dependabot Core's current parser model, and groups `splrad/steward/.github/workflows/*` into one update PR. This keeps all generated caller pins on one reviewed Steward version surface without grouping unrelated consumer Actions or Steward's intentionally independent internal runtime pins.

`init --preflight` is a separate read-only network check using the same non-secret spec. It verifies the target account installation, required App permissions, and—when the installation is limited to selected repositories—the target repository membership. A missing installation stops with the App's new-install URL; a repository missing from an existing installation stops with that installation's GitHub configuration URL. An unverifiable selected scope is reported as unknown and never treated as installed. For organization repositories, discovery first uses the organization-owner endpoint and then falls back to the current user's App installations. GitHub's user-installation and selected-repository endpoints accept only a GitHub App user access token; set that short-lived token as `STEWARD_APP_USER_TOKEN`. PATs and normal GitHub CLI OAuth tokens cannot prove selected scope. An organization-owner PAT can prove only an all-repositories installation through the organization endpoint. The preflight issues GET requests only and does not configure the App or repository.

`init --apply` is the explicit interactive mutation stage. It requires `GH_TOKEN` or `GITHUB_TOKEN` with repository administrator, Secrets, Variables, Contents, Pull requests, and Workflows access. When a selected-repositories App installation must be proven, provide a separate short-lived GitHub App user access token as `STEWARD_APP_USER_TOKEN`; it is used only for installation discovery and repository-membership proof, while every inventory and mutation request continues to use `GH_TOKEN`/`GITHUB_TOKEN`. This two-token boundary avoids granting the long-lived runtime App installer-only Secrets, Variables, or Workflows permissions. Before any mutation the CLI inventories the immutable default-branch commit, required Secret names, the App client-ID Variable, the deterministic `steward/init` branch, and any matching open PR; it then prints a non-sensitive plan and requires TTY confirmation. It fails closed on generated-file conflicts, a mismatched existing Variable, insufficient permission, or a same-named branch that is not the exact single-parent commit for the current default-branch head. Reuse verifies the complete bounded/paginated added, modified, and removed path set plus every final file state. `--json` and non-interactive confirmation are intentionally unsupported.

After confirmation, missing target Secret values are accepted only from a hidden interactive TTY—not specs, arguments, environment variables, files, or piped input. PATs use bounded single-line input; the GitHub App RSA private key uses bounded multiline input terminated by a line containing only `.`. Values are LibSodium sealed-box encrypted with GitHub's current repository public key before transport. The CLI creates one Git tree and commit based on the observed default-branch head, attaches only the new `steward/init` ref, creates missing Secrets without intentionally overwriting existing names, creates the missing client-ID Variable, and finally opens the PR; it never updates the default-branch ref. Cancellation and EOF fail closed, retained buffers are zeroed after use, and errors redact credential shapes and exact held values. If a later mutation fails, the CLI reports completed resource names and a rerun reuses only an exact branch/PR while skipping settings that now exist; it does not delete or roll back credentials whose prior values cannot be recovered.

The Actions-first `activate` module, adoption parser, and adoption source verifier remain historical test fixtures only. The public CLI rejects `activate` during argument parsing, public init specs reject `adoption` before reading a target, and the CLI bundle contains no adoption profile. Organization-native activation will first use the shared conformance verifier and then require an organization-owner transition of `steward_state` in GitHub's owner control plane. A future separate owner-bound lifecycle identity may automate that transition only after consumer repositories no longer receive the runtime App private key. A repository that still stores that key or its legacy callers must never enter `active`: GitHub rulesets validate the required Check name and App source, not Steward's `external_id`.

`upgrade --repo OWNER/REPOSITORY --to STEWARD_SHA` prepares an interactive lifecycle upgrade to one exact 40-character commit in `splrad/steward`. It reads the current default-branch Manifest and every enabled thin caller, verifies that existing managed workflows and Dependabot configuration still match the templates at their pinned Steward versions, and obtains the target schema and templates from the requested immutable commit. The target must be ahead of or identical to every current pin. The current CLI supports the explicit Schema v1-to-v1 migration surface; unsupported source or target schema versions, older/diverged targets, customized managed templates, and any confirmation-time drift fail closed. The resulting `steward/upgrade` commit updates the Manifest schema URL and generated files in a PR without changing the default-branch ref, repository credentials, App configuration, rulesets, or project release adapter. An exact existing branch/PR is reused after partial failure; unrelated same-named state is never reset or overwritten.

## Repository layout

- `action/`: bundled JavaScript Action published directly from a pinned commit.
- `packages/core/`, `packages/manifest/`, `packages/github/`, and `packages/control/`: runtime-neutral contracts, policy, transport adapters, and Control kernel.
- `packages/ingress/`: bounded public-role GitHub webhook verification and durable Queue producer; it has no live route yet.
- `packages/coordinator/`: private Queue consumer, fresh-wakeup producer, and per-PR SQLite Durable Object host.
- `packages/control-runtime/`: private versioned Worker adapter; real PR reconciliation is still fail-closed.
- `packages/relay/`: isolated legacy migration fixture and historical E2E evidence; deployment is manual-only and it is not a central-runtime rollback target.
- `packages/cli/`: lifecycle planning, bootstrap, upgrade, and read-only Doctor surfaces.
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
