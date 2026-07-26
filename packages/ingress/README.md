# Steward webhook Ingress

`steward-ingress` is the only public-role Worker in the central runtime. It
verifies the GitHub HMAC against the exact bounded request bytes, extracts only
the versioned pull-request reconcile envelope for pull-request, review,
review-comment, and review-thread changes, and acknowledges only after the
Queue accepts the canonical message. Payload details are change hints only;
the private Control re-reads current PR state. One nine-second platform
deadline covers bounded body ingestion through Queue persistence; timeout
returns `503`. A Queue write that succeeds after the deadline can only create
a duplicate, which the delivery ID and per-PR Coordinator absorb. Ingress has
no GitHub App or human credential.

Ingress writes work-item schema version 2. Version 1 remains byte-for-byte
stable and accepts only `pull_request`; Coordinator and Control readers accept
both versions. A live rollout must therefore deploy the compatible
Coordinator/Control first and establish that deployment as the rollback
boundary, then deploy Ingress, and only then subscribe the App to the new
events.

This foundation is intentionally not connected to the live GitHub App webhook.
GitHub does not automatically redeliver failed webhook deliveries, so a `503`
after Queue rejection is observable failure, not durable recovery. Live cutover
requires an App-authenticated failed-delivery sweeper with bounded lookback,
cursoring, replay identity, and idempotency before end-to-end durability can be
claimed.
