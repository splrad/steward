# SPLRAD Steward

SPLRAD Steward is shared automation for pull requests, releases, and repository governance across SPLRAD projects.

The project is being extracted from a production-tested, event-driven workflow. Its public interfaces are designed around three constraints:

- repositories keep only thin event-entry workflows, one versioned manifest, and optional release adapters;
- every state change is driven by a real GitHub event, with no scheduled refresh, sleep, or polling;
- consumers pin Steward workflows and the bundled Action to a complete commit SHA.

## Status

The repository contains a reproducible development foundation, the default-branch Manifest trust boundary, and the first shared identity, fingerprint, hidden-state, and pagination contracts. Remaining governance behavior is moving in dependency order before the sandbox or any production repository consumes it.

The normative system design and module acceptance criteria are documented in [Steward architecture](docs/architecture/README.md). The [reference architecture baseline](docs/architecture/reference-baseline.md) records which Arcade, Prow, GitHub, Microsoft, and Azure SDK patterns Steward adopts or rejects.

## Repository layout

- `action/`: bundled JavaScript Action published directly from a pinned commit.
- `packages/`: core policy, manifest, GitHub, relay, and CLI module boundaries.
- `schema/`: versioned project manifest schema.
- `templates/`: thin workflows, manifest examples, and release-adapter templates.
- `tests/`: contracts, fixtures, and static policy checks.
- `docs/architecture/`: normative boundaries, trust model, versioning, and reference checklist.
- `docs/migration/`: source-to-Steward compatibility and migration records.

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
