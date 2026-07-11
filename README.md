# SPLRAD Steward

SPLRAD Steward is shared automation for pull requests, releases, and repository governance across SPLRAD projects.

The project is being extracted from a production-tested, event-driven workflow. Its public interfaces are designed around three constraints:

- repositories keep only thin event-entry workflows, one versioned manifest, and optional release adapters;
- every state change is driven by a real GitHub event, with no scheduled refresh, sleep, or polling;
- consumers pin Steward workflows and the bundled Action to a complete commit SHA.

## Status

The repository contains a reproducible development foundation, the default-branch Manifest trust boundary, shared policy contracts, and an explicit GitHub transport/repository adapter. Action operations still need to connect core plans to those one-call mutation primitives, followed by thin reusable workflows, before the sandbox or any production repository consumes them.

## Repository layout

- `action/`: bundled JavaScript Action published directly from a pinned commit.
- `packages/`: core policy, manifest, GitHub, relay, and CLI module boundaries.
- `schema/`: versioned project manifest schema.
- `templates/`: thin workflows, manifest examples, and release-adapter templates.
- `tests/`: contracts, fixtures, and static policy checks.
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
