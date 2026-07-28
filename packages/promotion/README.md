# Steward protected runtime promotion

This package is the dedicated operator plane for already-existing immutable
versions of exactly `steward-control`, `steward-recovery`,
`steward-coordinator`, `steward-diagnostics`, or `steward-ingress`. Its only
mutation route is `POST /v1/runtime-promotion`. Its only recovery route is
`POST /v1/runtime-promotion/resolve-unknown`. Both are protected by Cloudflare
Access Service Auth and independent in-Worker issuer, audience, signature, and
exact Client ID verification.

Commands bind one exact expected deployment ID, explicit stable and candidate
Version IDs, a full Steward commit, and one operation:

- `stage` adds the candidate at 0%;
- `promote` moves the candidate monotonically to an explicit integer
  percentage from 1 through 100;
- `canary-stop` returns the candidate to 0%;
- `rollback` immediately returns the known stable Version to 100% and removes
  the candidate from the deployment.

When stable and candidate identify the same immutable Version, every operation
is an explicit durable no-op: the active deployment must already contain only
that Version at 100%, and the Worker never manufactures a duplicate split.

The Worker never resolves versions by tag, never selects the previous upload,
never sends `force`, and cannot choose a Worker outside that compile-time
allowlist. `steward-promotion` is deliberately absent, so this plane cannot
promote itself. Same-traffic requests are durable no-ops. Before any
deployment write, the Worker GETs the exact
candidate Version and requires its `workers/tag` annotation to equal
`steward-<stewardCommit>`. Every write follows GET-before, durable SQLite
`dispatching` intent, a second exact GET-before, POST, and GET-after. The POST
annotation includes the command ID. A delayed command whose second GET no
longer matches its durable before-evidence becomes `superseded` without a
write. A lost or unverifiable POST response is recorded as `unknown`; a retry
performs read-only reconciliation and never blindly repeats the write.

An unexpired `dispatching` lease remains in progress. After the short lease
expires, reconciliation is still read-only: desired traffic settles success, a
changed deployment ID settles `superseded`, and an exact unchanged deployment
becomes `unknown`. Active intent locks are per Worker so one uncertain Worker
does not block the other runtime Workers.

An exact-before `unknown` is never abandoned automatically. After at least 60
seconds without a state transition, the same Access principal may submit a
fresh, strict resolution containing the original command ID, Worker, and exact
before-deployment evidence. The Worker performs a new Cloudflare GET and only
then durably records `abandoned`. A new command can follow; the abandoned
command itself remains a failed terminal result.

Access JWKS and Cloudflare API JSON responses use caller cancellation,
per-call timeouts, strict JSON content types, and byte limits.

`CLOUDFLARE_WORKERS_WRITE_TOKEN` must be a separate, narrowly scoped Workers
Scripts Write token. It is not a Diagnostics token, GitHub credential, App
credential, administrator/bypass identity, or consumer secret.

Cloudflare's Create Deployment API has no compare-and-swap field for an
expected deployment ID. The second GET closes delayed races inside this
operator plane, but production operation must still enforce a single writer
across other tokens, dashboards, and deployment automation while a command is
active.

Cloudflare documents 0% Versions for version overrides and current Wrangler
sends that form, while the generated Create Deployment schema may still show a
positive minimum. The first production use must live-canary both stable-100 /
candidate-0 and stable-0 / candidate-100 response shapes before this entry is
allowed to drive the ordered runtime rollout.

The first deployment, and any change to the `RuntimePromotionLedger` Durable
Object export, requires a reviewed full SQLite Durable Object deployment.
This entry only manages versions that already exist; it never uploads or
creates an immutable Version. This source does not deploy the Worker, create
the Access application or Service Auth policy, upload the write token, stage a
candidate, alter traffic, execute the multi-Worker deployment order, or
replace the existing authenticated Diagnostics final barrier.
