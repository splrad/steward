# Reference architecture baseline

This checklist turns external architecture references into Steward decisions. A reference is evidence, not a source to copy wholesale.

## .NET Arcade

Reference: [dotnet/arcade](https://github.com/dotnet/arcade) provides common build infrastructure for multiple .NET projects and distributes shared engineering behavior through versioned dependencies and repository integration files.

Adopt:

- one maintained engineering-system repository;
- consistent repository language and entrypoints;
- versioned consumption and automated dependency upgrade changes;
- shared implementation with project-owned build adapters;
- staged validation before broad dependency flow.

Do not adopt:

- Azure DevOps-, Maestro-, NuGet-feed-, or Microsoft-internal service coupling;
- synchronized copies when GitHub can call a reusable workflow or Action by full SHA;
- project build conventions as universal governance policy.

Steward check:

- Is the behavior centralized without hiding project-specific commands?
- Can a consumer remain on its current SHA until an upgrade PR is reviewed?
- Does the upgrade include compatibility evidence rather than only a version change?

## Kubernetes Prow

Reference: [Prow overview](https://docs.prow.k8s.io/docs/overview/) describes event-triggered jobs, pluggable GitHub automation, source-controlled configuration, and multi-organization operation.

Adopt:

- webhook-driven policy and status transitions;
- declarative per-repository configuration;
- plugins/modules with narrow responsibilities;
- explicit GitHub identity and event validation;
- one control plane serving multiple repositories;
- source-controlled configuration and conformance tests.

Do not adopt:

- a Kubernetes job scheduler, merge queue, dashboard, or cluster control plane;
- periodic controllers or scheduled status reconciliation;
- Prow's internal APIs or compatibility policy as Steward contracts;
- global mutable configuration that bypasses the consumer default branch.

Steward check:

- Which real event advances this state?
- Does one event produce at most one finite convergence run?
- Is each policy capability separable from transport and GitHub mutation?
- Can duplicate and stale webhook deliveries be proven harmless?

## GitHub reusable automation

References:

- [Reusing workflow configurations](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations)
- [Creating organization workflow templates](https://docs.github.com/en/actions/how-tos/reuse-automations/create-workflow-templates)

Adopt:

- reusable workflows for multi-job orchestration;
- JavaScript Actions for reusable executable steps;
- organization templates for required local event entrypoints;
- complete commit SHA references;
- explicit inputs, outputs, Secrets, permissions, and runner ownership;
- dependency-graph visibility and reviewed upgrade PRs.

Do not adopt:

- floating branch or tag references for governance code;
- copied starter workflows as a long-term shared implementation;
- implicit Secret inheritance where a fixed mapping is part of the contract;
- the assumption that reusable workflows can replace repository-local native event declarations.

Steward check:

- Is this a job graph, an executable step, or project configuration?
- Does it belong in a reusable workflow, the Action, or the Manifest?
- Is the caller thin enough that upgrades do not require algorithm edits in consumers?
- Is the called revision immutable and auditable?

## Microsoft product repositories

Repositories such as [microsoft/vscode workflows](https://github.com/microsoft/vscode/tree/main/.github/workflows) keep many product-specific pipelines locally. This is appropriate for a large monorepo whose build matrix is itself product code, but it is not the Steward consumer model.

Adopt individual proven techniques only after isolating their assumptions. Do not use a product repository's local workflow count or YAML layout as a cross-repository platform template.

## Azure SDK tools

Reference: [Azure SDK Tools](https://github.com/Azure/azure-sdk-tools) centralizes tools used across SDK repositories.

Adopt its separation of shared tools from language/product repositories and its use of repository-level policy. Do not adopt periodic pipeline discovery, Azure DevOps coupling, or language-specific release machinery as Steward infrastructure.

## Per-module review checklist

Every new Steward module must answer these questions in its PR:

### Ownership

- What behavior is universal Steward protocol?
- What varies by repository and where is that represented in the Manifest or adapter?
- Does any string, path, login, label, runner, or product name belong to one current consumer?

### Trigger and convergence

- Which native event or verified webhook invokes the module?
- What finite GitHub datasets are read once?
- Which one-shot mutation or dispatch may occur?
- Which later event completes asynchronous convergence?
- Can an idle PR remain idle indefinitely without Actions usage?

### Trust

- Is configuration loaded from the current default branch?
- Are repository ID, PR number, open state, base, head, App identity, and configuration digest bound where needed?
- Can PR text, workflow names, artifacts, dispatch payloads, or Check names be forged?
- Does malformed legacy state fail closed without losing safe compatibility?

### Idempotency

- What is the stable identity of each comment, Check, request, dispatch, or delivery?
- What happens when the same event is delivered twice?
- What happens when a new head arrives before old work completes?
- Does recovery update existing state rather than create noise?

### Reuse boundary

- Is pure policy in `core`?
- Is GitHub transport and mutation in `github`?
- Is job orchestration in reusable workflows?
- Is repository-specific build behavior in an adapter?
- Does the consumer contain only an event entrypoint, Manifest, Secret mapping, and optional adapter?

### Versioning and rollout

- Which Schema, executable SHA, protocol identifier, and adapter contract versions apply?
- Is the writer current and the reader explicitly backward compatible?
- Does the upgrade occur through a reviewable PR?
- Is there a sandbox test for fork, duplicate, stale, failure, recovery, and upgrade paths?

### Operations

- Are permissions sufficient for every actual operation and no required capability omitted?
- Are diagnostics available in Checks and step summaries without exposing Secrets or webhook bodies?
- Is there a manual one-shot recovery path without an automatic health poller?
- Can `doctor` explain configuration, App, Check, ruleset, and relay drift read-only?

## Rejection rule

A mature-project pattern is rejected when it requires unavailable private infrastructure, weakens the default-branch trust boundary, introduces time-based reconciliation, silently updates consumers, duplicates shared algorithms, or turns project policy into a Steward constant.

Rejected patterns are recorded with their reason; they are not kept as dormant options in the implementation.
