# Steward webhook Ingress

`steward-ingress` is the only public-role Worker in the central runtime. It
verifies the GitHub HMAC against the exact bounded request bytes, extracts only
the versioned pull-request reconcile envelope, and acknowledges only after the
Queue accepts the canonical message. One nine-second platform deadline covers
bounded body ingestion through Queue persistence; timeout returns `503`.
A Queue write that succeeds after the deadline can only create a duplicate,
which the delivery ID and per-PR Coordinator absorb. Ingress has no GitHub App
or human credential.

This foundation is intentionally not connected to the live GitHub App webhook.
GitHub does not automatically redeliver failed webhook deliveries, so a `503`
after Queue rejection is observable failure, not durable recovery. Live cutover
requires an App-authenticated failed-delivery sweeper with bounded lookback,
cursoring, replay identity, and idempotency before end-to-end durability can be
claimed.
