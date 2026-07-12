# CADFontAutoReplace migration map

Source baseline: `axiomoth/CADFontAutoReplace@f6331185c12920cbb6d7b639f84a38b4d04ad71b`.

This map defines where the production-tested implementation moves. It is a boundary record, not permission to copy project-specific release or classification behavior into the shared protocol.

## Shared modules

| Current source | Steward destination | Boundary |
|---|---|---|
| `.github/scripts/pr-api-pagination.js` | `packages/github/src/pagination.ts` | Reusable REST pagination and link traversal. |
| `.github/scripts/pr-notifications.js` | `packages/core/src/identity.ts` and `packages/github/src/comments.ts` | Split pure login/mention rules from GitHub comment mutation. Preserve bot filtering and marker upsert behavior. |
| `.github/scripts/pr-validation-fingerprint.js` | `packages/core/src/fingerprint.ts` | Stable validation input normalization and digest. |
| `.github/scripts/pr-classification-policy.js` | `packages/core/src/classification.ts` | Pure path, type, area, and label policy evaluation driven by manifest data. |
| `.github/scripts/pr-classification.js` | `packages/github/src/classification.ts` plus Action operation | GitHub reads/writes remain adapters; classification decisions move to core. |
| `.github/scripts/pr-automation.js` | `packages/core/src/pull-request.ts` and `packages/github/src/pull-request.ts` | Separate title/body/contributor decisions from PR mutation. |
| `.github/scripts/dco-check.js` | `packages/core/src/dco.ts` and `packages/github/src/dco.ts` | Advisory evaluation is shared; presentation stays localized by Steward. |
| `.github/scripts/pr-governance.js` | `packages/core/src/governance/` and `packages/github/src/governance.ts` | Split authorization, Copilot parsing, aggregate-comment state, and API mutation. Keep legacy hidden-state decoding. |
| `.github/scripts/pr-validation-matrix.js` | `packages/core/src/matrix/` and `packages/github/src/matrix.ts` | Matrix evaluation, trust, repair planning, proxy Checks, and dispatch adapters. Matrix remains the sole aggregator. |
| `.github/scripts/pr-cleanup.js` | `packages/core/src/cleanup.ts` and `packages/github/src/cleanup.ts` | Preserve marker cleanup and close/merge notification contracts. |
| `.github/scripts/*.test.js` | `tests/contracts/` and `tests/fixtures/cadfontautoreplace/` | Port behavior before implementation; fixtures must be sanitized and deterministic. |
| `.github/scripts/workflow-event-policy.test.js` | `tests/static/` and `scripts/verify-workflows.mjs` | Enforce no cron, sleep, polling, floating Actions references, or unsafe event entrypoints. |

## Workflow ownership

| Current workflow | Steward destination | Target-repository remainder |
|---|---|---|
| `pr-automation.yml` | reusable `.github/workflows/pr-automation.yml` | Thin native PR event entrypoint and explicit secrets mapping. |
| `pr-classification.yml` | reusable `.github/workflows/pr-classification.yml` | Thin PR/workflow-dispatch entrypoint. |
| `dco-check.yml` | reusable `.github/workflows/dco-advisory.yml` | Thin PR/workflow-dispatch entrypoint. |
| `pr-governance.yml` | reusable `.github/workflows/pr-governance.yml` | Thin trusted event entrypoint with App and PAT secret mapping. |
| `pr-review-signal.yml` | reusable `.github/workflows/pr-review-signal.yml` | Repository-local native review-request signal only. Review/comment/thread events enter through Relay. |
| `pr-validation-matrix.yml` | reusable `.github/workflows/pr-validation-matrix.yml` | Thin `workflow_run`, `repository_dispatch`, Check, and manual recovery entrypoint. |
| `pr-cleanup.yml` | reusable `.github/workflows/pr-cleanup.yml` | Thin close event entrypoint. |
| `release-build.yml` | reusable `.github/workflows/release.yml` | Thin merged-PR entrypoint plus local release adapter. |
| `deploy-webhook-relay.yml` | `.github/workflows/deploy-relay.yml` | Removed from consumer repositories after the shared Relay is active. |

## Relay

| Current source | Steward destination | Required change |
|---|---|---|
| `.github/webhook-relay/src/index.ts` | `packages/relay/src/worker.ts` and `packages/relay/src/delivery-coordinator.ts` | Preserve HMAC verification and SQLite Durable Object claims; remove `TARGET_REPOSITORY`; load the default-branch manifest and require relay opt-in. |
| `.github/webhook-relay/test/index.test.ts` | `packages/relay/test/` | Retain official HMAC, event filtering, duplicate delivery, concurrent claim, dispatch failure, and secret-safety cases; add multi-repository manifest cases. |
| `.github/webhook-relay/wrangler.toml` | `packages/relay/wrangler.toml` | Rename deployment to `steward-relay` while preserving the SQLite migration class. No KV binding or scheduled trigger. |
| `.github/webhook-relay/package*.json` | root lockfile/workspace | Dependencies become part of the single reproducible Steward toolchain. |

## Compatibility protocol

The following are Steward-owned contracts and are not ordinary project configuration:

- Check names, Matrix target order, allowed conclusions, and the versioned `external_id` format.
- Aggregate blocking-comment marker, source keys, hidden-state encoding, same-head update, new-head replacement, and automatic deletion after recovery.
- Current Copilot identity normalization, severity header, summary-title extraction, official no-comment conclusion, current-head filtering, and unresolved-thread semantics.
- Trusted event/run-name validation, stale repository/base/head rejection, proxy Check idempotency, and event-driven one-shot repair behavior.
- Bot exclusion from contributor attribution and mentions.

Legacy comment state and Check identifiers must decode during migration so an upgrade neither duplicates comments nor loses an active block.

## Project configuration

The following remain owned by CADFontAutoReplace and enter Steward only through its default-branch manifest or release adapter:

- `.github/pr-classification-rules.json`: path groups, areas, kinds, and public/release labels.
- `TRUSTED_DEVELOPERS`: temporary legacy identity source; the migrated organization source is the configured `splrad/maintainers` team.
- `.github/pr-validation-matrix.json`: current file is migration input only; target IDs, Check names, order, and repair protocol become Steward-owned.
- `.github/release.yml`: repository release-note categories.
- `Version.props`, `.github/scripts/generate-release-notes.ps1`, and project build/publish commands: local release adapter implementation.
- `.github/copilot-instructions.md` and repository-specific review rules: consumer policy content, while the severity/title wire format remains a Steward compatibility contract.
- Product names, build runners, trigger paths, asset layout, labels, and language selection.

## Extraction order

1. Port current tests and sanitized fixtures without changing expected behavior.
2. Extract pure identity, notification-state, fingerprint, classification, DCO advisory, governance, and Matrix decisions.
3. Add GitHub adapters and the bundled Action behind those contracts.
4. Convert workflows to reusable callers and generate thin target templates.
5. Generalize Relay, then validate all paths in `splrad/steward-sandbox` before touching production consumers.
