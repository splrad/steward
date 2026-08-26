# Contributing to SPLRAD Steward

SPLRAD Steward is the organization's shared automation service. It is not a general-purpose GitHub automation product. Contributions should address an existing Steward workflow, configuration contract, validation rule, or operational defect.

Before changing code, read the affected configuration, schema, workflow, and tests. Keep project-specific behavior in the repository configuration rather than adding ad hoc conditions to central workflows.

## Local setup and checks

Steward uses Node.js `24.14.1` and npm `11.11.0`.

```powershell
npm ci --ignore-scripts
npm run verify
```

`npm run verify` runs the repository's tests, type checks, configuration validation, generated-file validation, and workflow validation. For a focused change, run the relevant check and state any checks you did not run in the Pull Request.

Changes to `packages/runner/src/index.ts` or its dependencies require a rebuild of the committed runtime file. Run `npm run build`, then confirm `npm run verify:dist` succeeds.

## Pull requests

Use a short-lived branch and keep the pull request scoped to one problem. Do not include unrelated formatting, generated churn, credentials, private paths, customer data, or runtime secrets.

The organization Pull Request template is managed by this project. Keep its managed markers intact and add the actual validation evidence in the human-supplement section. A passing check does not replace a clear explanation of changes that affect repository governance, permissions, or event handling.

Use the repository's security policy for suspected vulnerabilities. Do not report them in a public pull request.
