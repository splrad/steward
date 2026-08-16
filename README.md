# SPLRAD Steward

SPLRAD Steward is the central automation source for repositories in the `splrad` organization.

The repository owns three pull-request workflows, Copilot instruction synchronization, public-repository onboarding, LayerScape release automation, and one stateless webhook runtime. Consumer repositories do not copy Steward workflows or secrets.

## Local verification

```powershell
npm ci --ignore-scripts
npm run verify
```

The generated runner at `packages/runner/dist/index.js` is committed and must match `packages/runner/src/index.ts` byte for byte after rebuilding.
