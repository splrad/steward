# Steward Recovery

`steward-recovery` is the isolated delivery-recovery plane.

- Its Queue handler consumes `steward-events-dlq`, validates and durably
  captures every message in a SQLite Durable Object, and acknowledges the DLQ
  message only after the capture is durable.
- Its public HTTP surface is protected by Cloudflare Access and accepts only
  strict, fresh, bounded recovery commands.
- DLQ replay writes the exact stored canonical work item back to
  `steward-events`; existing repository and pull-request Durable Objects remain
  the deduplication authority.
- GitHub failed-delivery enumeration and redelivery are orchestrated from the
  durable ledger, but the App JWT and GitHub mutation remain inside the private
  Control Worker.

## Operator protocol

The single `POST /v1/recovery` endpoint accepts three exact command shapes:
`inspect`, `replay-dlq`, and `recover-github`. Every command carries a fresh
canonical `requestedAt` and UUID `requestId`. A short DLQ-replay retry repeats
the exact command; after its freshness window, the operator uses a new
`requestId` and time. Only an in-progress GitHub scan preserves its
`requestId` while refreshing `requestedAt` for continuation.

GitHub recovery additionally requires:

- `coverageMode: "continue"` for normal scans. It fails closed if no durable
  checkpoint exists or the checkpoint has fallen outside the provider window.
- `coverageMode: "establish"` only when the operator explicitly acknowledges
  that the initial or expired provider-retention gap cannot be reconstructed.
  The response remains `complete-with-retention-gap` with
  `actionRequired: true`; it is never reported as continuous coverage.
- `takeover: false` for normal work. An expired scan has a fixed absolute
  ten-minute lease and requires a new `requestId` with `takeover: true`.
  A live lease cannot be taken over. Access service-token rotation does not
  strand an expired lease because the current, strictly verified principal may
  perform the explicit takeover.

Provider timestamps and the durable checkpoint are compared at GitHub's
one-second precision. Each new scan claims at most 71 hours 45 minutes of the
provider's three-day retained history, leaving a 15-minute completion margin.
Pagination persists before redelivery and never extends the original lease.

Before any GitHub redelivery POST, the ledger commits a `dispatching` intent.
An accepted, lost, malformed, timed-out, redirected, or provider-5xx result
that cannot prove rejection becomes `unknown`; it is never blindly posted
again. Inspection exposes bounded unresolved intent metadata so an operator can
match the GUID and attempt in GitHub. A later complete scan reconciles an
observed newer attempt. If no new attempt appears, the operator may use
GitHub's delivery UI and then scan again; Steward does not guess.

A definite provider rejection also remains an action-required, cross-generation
fence for that GUID. Repeating a scan cannot erase it or reset the per-GUID
redelivery limit. Only a strictly newer observed delivery attempt can reconcile
the rejection; a newer failed attempt may become a candidate while budget
remains, and an exact successful attempt closes the fence. Manual intervention
therefore happens in GitHub's delivery UI, followed by another scan, rather
than by blind automatic retries.

Recovery signs each private Control request with an HMAC over the method,
path, canonical body, timestamp, nonce, and exact Control revision. The nonce
is a fresh signature-uniqueness field, not a durable one-time token. This is
safe only while Control has no public route, Recovery never exposes or logs
capability headers, and neither layer automatically retries a redelivery POST.
The durable `dispatching` fence is the normal-failure replay boundary.

The worker has no GitHub credentials and no Cloudflare account API token.
Diagnostics remains read-only and also observes the terminal
`steward-recovery-capture-dlq`; backlog in either DLQ is not healthy. Settled
capture identity is the canonical body digest plus bounded source audit, so
Queue at-least-once delivery does not create a second logical entry. Capture
failures receive up to 100 consumer retries before reaching the terminal DLQ;
that queue is retention-bounded rather than permanent, so its diagnostics
signal requires timely action. Settled ledger history is intentionally retained
in this first version. Capacity and compaction remain explicit follow-up work:
compaction must preserve unresolved intents, coverage evidence, exact-success
facts, and redelivery-count fences.

## Deployment boundary

The first deployment of
`DeliveryRecoveryLedger` must be a reviewed full Durable Object deployment;
later compatible versions can use the normal candidate/canary promotion flow.
Deployment order remains compatible Control, full Recovery/Coordinator Durable
Object exports, then Ingress and canary.

This source does not enable the GitHub App webhook or deploy the new recovery
topology by itself.
