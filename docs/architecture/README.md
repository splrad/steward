# Steward architecture

This document is the normative architecture for SPLRAD Steward. It defines where behavior lives, which inputs are trusted, how repositories consume Steward, and what every module must prove before it can be shared.

The design combines three established patterns:

- [.NET Arcade](https://github.com/dotnet/arcade): one engineering system, versioned consumption, and repository-specific adapters;
- [Prow](https://docs.prow.k8s.io/docs/overview/): event-driven GitHub automation, declarative policy, and multi-repository operation;
- [GitHub reusable workflows](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations): thin callers, centrally maintained jobs, organization templates, and complete-SHA pinning.

Steward adopts those boundaries without copying their product-specific pipelines, Kubernetes control plane, Azure DevOps services, scheduled reconcilers, or internal dependency infrastructure. The detailed adoption checklist is in [reference-baseline.md](reference-baseline.md).

## System boundary

Steward is an engineering system for repository governance. It is not a general CI scheduler and it does not own project builds.

Steward owns:

- trusted PR governance, classification, DCO advisory, review state, and validation aggregation;
- reusable orchestration and the bundled Action that executes Steward operations;
- the default-branch Manifest protocol and compatibility identifiers;
- GitHub adapters, App-authenticated Checks, comments, review requests, and one-shot repair dispatches;
- the multi-repository webhook relay and delivery idempotency;
- initialization, activation, diagnosis, upgrades, templates, and conformance testing.

Each consumer repository owns:

- native event-entry workflow files required by GitHub;
- `.github/steward.json` and its project policy;
- repository Secrets and explicit workflow permissions;
- build commands and an optional Release adapter;
- product-specific review instructions, labels, paths, assets, runners, and rules unrelated to Steward.

## Architecture planes

### 1. Policy plane

`packages/manifest` loads and validates `.github/steward.json` from repository metadata and the current default branch. It never accepts a PR-controlled ref. `packages/core` evaluates normalized policy with pure functions and does not read process environment or call GitHub.

Project-specific names and behavior belong in the Manifest. Check names, hidden-state formats, target ordering, fingerprints, and event-validation protocols belong to versioned Steward contracts.

### 2. Integration plane

`packages/github` translates GitHub REST, GraphQL, Check, review, comment, and workflow APIs into typed inputs and mutations. It may depend on `core` and `manifest`; policy decisions must not be reimplemented here.

Every mutation is idempotent by a versioned identity such as a marker, Check `external_id`, delivery ID, PR/head/config digest, or source-family key.

### 3. Execution plane

The bundled `action/` exposes named Steward operations. Reusable workflows in the Steward repository provide jobs, runners, permissions, and explicit Secret inputs. Consumer workflows contain only native `on:` events, required permissions, Secret mappings, and a complete-SHA reference to the reusable workflow.

Native GitHub events remain local because GitHub discovers event workflows from the consumer repository. Shared workflows do not invent or infer events.

### 4. Control plane

The GitHub App is the trusted automation identity. App-created Checks are the authoritative Steward status source. `packages/relay` receives review events unavailable as native Actions triggers, verifies the webhook signature, loads the installation repository's default-branch Manifest, deduplicates the delivery, and emits one repository dispatch.

The relay routes events; it does not evaluate PR policy or keep a repository status cache. Delivery coordination is the only durable relay state.

### 5. Lifecycle plane

`packages/cli` and organization workflow templates install thin entrypoints, create the Manifest and adapter skeleton, verify prerequisites, activate rulesets after a real App Check exists, diagnose drift, and create SHA-upgrade PRs.

No upgrade changes a consumer silently. A new Steward version reaches a repository only through a reviewed change to its pinned SHA and compatible Manifest.

### 6. Assurance plane

`tests/contracts` protects public protocols and legacy decoding. Sanitized fixtures prove real consumer policy. `steward-sandbox` validates fork PRs, webhook delivery, Check identity, idempotency, upgrade paths, and a synthetic Release adapter before production migration.

Static tests enforce module boundaries, exact dependencies, complete action SHAs, reproducible generated artifacts, and the absence of time-based state polling.

## Dependency direction

Dependencies point inward toward policy. Reverse dependencies are forbidden.

```text
manifest
   ↑
 core
   ↑
 github
  ↗  ↖
relay  action/reusable workflows
         ↑
        cli/templates
```

Allowed package dependencies:

| Package | May depend on |
|---|---|
| `manifest` | no other Steward package |
| `core` | `manifest` types and normalized configuration |
| `github` | `core`, `manifest` |
| `relay` | `github`, `core`, `manifest` |
| `cli` | `github`, `core`, `manifest` |

The Action may compose `github`, `core`, and `manifest`. Reusable workflows invoke the Action; they do not duplicate algorithms. CLI and Relay do not import each other.

## Trusted data flow

1. A native GitHub event or verified App webhook identifies a repository and candidate PR.
2. Steward rereads repository metadata and the PR from GitHub.
3. Repository ID, open state, default base, and current head must match the event. Stale or cross-repository input is ignored or fails closed.
4. The Manifest is loaded only from the current default branch and normalized into a configuration digest.
5. GitHub adapters collect each required finite dataset once, using bounded pagination.
6. Pure core functions calculate decisions, fingerprints, presentation models, and mutation plans.
7. Adapters apply each mutation at most once. Dispatched child work is represented by an in-progress proxy Check; the current run ends immediately.
8. A later real GitHub event rereads state and converges the Matrix. No workflow waits for another workflow.

Untrusted text is never treated as authority. PR bodies and comments may carry versioned hidden metadata for continuity, but every decoded value is validated and bound to current repository, PR, head, configuration, and App identity before it can affect a gate.

## State ownership

GitHub remains the source of truth for PRs, reviews, threads, workflow runs, and Checks. Steward persists only the minimum continuity data:

- App Check runs and versioned `external_id` values;
- one aggregate blocking comment with a legacy-decodable hidden state;
- webhook delivery claims in a SQLite Durable Object;
- versioned repository configuration on the default branch.

Steward does not maintain an independent PR-state database, background reconciler, scheduled refresh, or time-based retry queue.

## Version and compatibility model

Four versions evolve independently:

- Manifest `schemaVersion` controls project configuration compatibility;
- Action and reusable-workflow full commit SHA controls executable code;
- protocol identifiers in Check `external_id`, hidden comments, dispatch events, and run names control state compatibility;
- Release adapter contract version controls project build integration.

Readers accept explicitly supported legacy formats; writers emit only the current format. Unsupported Manifest versions fail immediately. Compatibility changes require contract fixtures and an upgrade migration before a consumer SHA changes.

## Consumer footprint

A fully migrated repository contains only:

```text
.github/steward.json
.github/workflows/<thin event entrypoints>.yml
.github/steward/release-adapter.*       # only when release is enabled
.github/dependabot.yml                  # includes Steward SHA updates
```

It must not contain copied Steward policy algorithms, relay deployment code, matrix configuration, or repository-specific forks of shared workflows.

## Extension model

Steward has explicit extension points rather than arbitrary plugins:

- **Manifest policy:** classification paths, kind mappings, public/release label decisions, maintainers, feature switches, release triggers, language, and adapter selection are declarative default-branch data. The evaluator contains no consumer label names or product paths.
- **Maintainer source:** organization repositories resolve a configured team slug through GitHub; migration repositories may use an explicit login list. Runtime environment variables are not a policy source.
- **Presentation catalog:** `automation.language` selects a Steward-owned, versioned catalog. Core produces presentation models; localization supplies visible titles, instructions, separators, and fallback text. Repository policy may define label descriptions but not replace governance protocol wording with executable templates.
- **Release adapter:** a project adapter implements the versioned `plan --context <json> --output <json>` and `build --context <json> --output-dir <dir> --manifest <assets.json>` contract. Steward owns event validation, tags, Releases, notes, upload, and failure Checks; the adapter owns version discovery and asset construction.
- **Workflow inputs:** reusable workflows expose only stable operational inputs. Values that change policy outcomes belong in the Manifest, not caller YAML.

New extension points require a protocol version, strict input validation, a sandbox implementation, and a demonstrated use case. Steward does not load arbitrary third-party JavaScript as governance policy.

## Failure and presentation semantics

Steward distinguishes four states:

- **passed:** current repository, head, configuration, and required evidence are positively verified;
- **pending:** asynchronous child work exists or required evidence has not arrived; Matrix remains in progress;
- **failed:** verified policy evidence blocks merging or an operation explicitly failed;
- **ignored:** the event is valid but stale, closed, out of scope, or disabled by trusted configuration.

Missing or malformed authority evidence fails closed. Advisory features report their result without becoming merge authority. A pending child workflow is never temporarily mapped to failure.

Contributor-facing comments are action-oriented and low-noise. Steward maintains one aggregate blocking comment per current head, updates it by source family, removes it after recovery, and does not post success chatter. Full diagnostics remain in App Checks and the Actions step summary.

## Permissions and credentials

Permissions are derived from actual operations, not from a generic minimal-permission slogan and not from historical settings.

- consumer entrypoints declare every required Actions permission explicitly;
- reusable workflows declare fixed Secret inputs and never silently fall back to a weaker token;
- App installation tokens are scoped to the event repository and the permissions needed by that operation;
- the App private key is the shared automation identity; repository PATs exist only for GitHub capabilities that cannot be performed by the App, such as requesting an entitled Copilot reviewer or submitting a human approval;
- PAT responsibilities remain separate and are validated with a real consumer action, not merely token creation;
- Relay logs exclude request bodies, webhook signatures, private keys, installation tokens, and Secrets.

Any permission change must identify its concrete API consumer and update recovery documentation.

## Deployment topology

The deployed system has five repositories or services with different ownership:

| Component | Responsibility |
|---|---|
| `splrad/steward` | source, reusable workflows, Action, Schema, CLI, Relay code, versioned releases |
| `splrad/.github` | organization workflow templates and public organization guidance |
| `splrad/steward-sandbox` | destructive and end-to-end conformance before consumer rollout |
| consumer repositories | thin event entrypoints, Manifest, Secrets, ruleset, optional Release adapter |
| Cloudflare Worker | shared webhook ingress and SQLite Durable Object delivery coordination |

The GitHub App is installed only on selected repositories. The Worker discovers repository eligibility from the installation event and the repository's default-branch Manifest; it has no hard-coded target repository list.

Production migration is two-phase: install and validate Steward alongside existing required checks, then activate the App-authored Matrix Check and retire old workflows only after a real event chain succeeds. Rollback changes the consumer's pinned SHA or ruleset; it does not require redeploying every repository.

## Module delivery order

Modules are implemented in dependency order and each is merged as an independently verified baseline:

1. reproducible repository and Action foundation;
2. Manifest trust boundary and normalization;
3. identity, fingerprint, hidden state, and bounded pagination;
4. complete Manifest-driven classification decisions;
5. authorization, Copilot, aggregate presentation, and governance plans;
6. Matrix evaluation, trusted Check identity, and one-shot repair plans;
7. GitHub mutation adapters and Action operations;
8. reusable workflows and generated thin entrypoints;
9. multi-repository Relay;
10. CLI lifecycle operations and sandbox migration;
11. consumer migration and ruleset activation.

No later layer may be used to compensate for an incomplete earlier contract.

## Definition of done for a shared module

A module is shareable only when all of the following are true:

- its project policy inputs exist in the strict default-branch Manifest;
- its pure decisions are independent of repository names, product paths, users, labels, and language text;
- GitHub I/O is isolated behind an adapter and all finite collections are fully paginated;
- events, repository, base, head, App identity, and configuration digest are validated where relevant;
- mutations are idempotent and asynchronous work returns pending without waiting;
- legacy readers, current writers, duplicate events, stale events, and malformed untrusted state are tested;
- sandbox conformance covers the real event chain;
- permissions and Secrets are explicit and justified by actual consumers;
- generated artifacts are reproducible and every external Action uses a complete SHA;
- the module passes the checklist in [reference-baseline.md](reference-baseline.md).
