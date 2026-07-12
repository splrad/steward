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
```

`doctor` is read-only and requires `GH_TOKEN` or `GITHUB_TOKEN`. `init --dry-run` is a pure local planner: its strict JSON spec contains one complete Steward commit SHA, a full Manifest, and an optional Node release-adapter declaration. It reads the target only to classify each generated file as `create`, `unchanged`, or `conflict`; it never writes files, calls GitHub, accepts Secret values, or changes a default branch. A conflict makes the command fail closed. Release generation emits an intentionally failing adapter skeleton that must be implemented before applying the plan. The legacy `prAutomation` and DCO advisory surfaces are not generated yet and are rejected when enabled.

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
