# Steward runtime diagnostics gateway

`steward-diagnostics` is the only public read surface for the central runtime.
Cloudflare Access must protect its fixed `workers.dev` hostname with one exact
Service Auth token. The Worker independently verifies the Access JWT issuer,
audience, signature, and service-token Client ID before reading any runtime
fact.

The gateway holds no GitHub App, human, webhook, deployment, or consumer
credential. It uses separate account-scoped `Workers Scripts Read` and
`Queues Read` API tokens to read the current Control deployment, Queue
topology, and realtime DLQ metrics. It invokes private
`steward-control` through a service binding with repository-stable version
affinity; Control rebinds the repository through the live GitHub App
installation and returns its actual version metadata.

Each request is a strict `POST /v1/runtime-diagnostics` challenge. Responses
are `no-store`, echo the per-read nonce, and are emitted only when the active
Control deployment is unchanged across the private probe, has one unique 100%
production version (all other versions at 0%), and that exact version actually
executed. The event Queue topology requires both intentional worker producers:
Ingress publishes webhook events and Coordinator publishes deferred wakeups.
DLQ metrics are point-in-time best-effort observations; `clear` requires count,
bytes, and oldest-message timestamp all to be zero, and means only that both
Doctor reads observed zero, not that no message can arrive later.

The public route must not be activated before the Access application and exact
Service Auth policy exist. `steward-control` and `steward-coordinator` remain
private, and `steward-ingress` does not participate in diagnostics.
