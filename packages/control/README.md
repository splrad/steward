# Steward Control

`packages/control` owns runtime-neutral, level-triggered orchestration for normalized Steward operations.
Each reconcile accepts only routing facts, resolves live repository and pull-request evidence, turns that evidence into
a versioned canonical JSON mutation plan, verifies the plan, and applies its ordered intents through caller-supplied
capability ports.

The first Stage 6.6 item 4 slice covers Classification and DCO Advisory. Their existing GitHub Action entrypoints
are adapters over this same kernel; they are not a second implementation. Later Stage 6.6 slices will migrate
Governance/Copilot, Matrix, and PR Automation/Cleanup into the same kernel. Repository bootstrap belongs to the
separate lifecycle control plane and is not an item 4 completion condition.

PR Automation and Matrix do not share the pull-request-only subject used by this first slice. PR Automation starts
from repository/branch events and may create or maintain a pull request. Matrix will use an explicit
`pull_request | merge_group` tagged subject; a merge-group plan binds the merge-group head SHA and must not inherit
PR-number, body, label, or comment assumptions. Those subject contracts are intentionally deferred to their own
slices rather than being implied by the current Classification/DCO ports.

This package does not own raw webhook or Actions events, environment variables, credentials, Node APIs,
Cloudflare bindings, Ingress, Queue, Durable Objects, the transitional Matrix workflow bridge, or release build
execution. A plan is bound to repository ID, default branch, PR, head SHA, normalized non-platform PR inputs,
Manifest source/config digests, and the App numeric ID/client ID/slug. The route cannot carry a Manifest or caller
snapshot. Reconcile binds the repository's live default branch once, captures a zero-argument Manifest loader for that
branch, and revalidates live evidence at apply time. The current Action adapter plans and applies in one invocation;
durable serialization and at-least-once coordination remain the responsibility of the later per-PR coordinator.

The runtime supplies the trusted GitHub App numeric ID, client ID, and slug independently of the consumer Manifest.
Reconcile rejects any subject or live Manifest identity mismatch, Classification accepts only Checks from the bound
numeric App identity, and the plan verifier permits DCO deletion only for the bot login derived from that identity.

Classification does not own or write the pull-request body. Legacy Classification markers are stripped only from the
evaluation snapshot, so they cannot classify themselves, while the contributor-authored body remains byte-for-byte
unchanged. The App-owned Check identity and conclusion are machine gate authority, managed labels are visible derived
state, and Check output carries human-readable diagnostics. DCO Advisory preserves GitHub's pull-request commit order
as semantic history and may delete only a legacy comment whose server-proven author is the bound App bot. A comment
that disappears after its final provenance/body check is already converged.

Before reading Classification commits/files or building a full plan, reconcile creates or recovers an attempt-bound,
same-head, same-App Check generation as an `in_progress` lease. When no managed Check exists it first loads the Manifest
so a disabled feature can remain a true zero-write result; an enabled feature then creates the lease before expensive
evidence reads. Distinct attempts never mutate the same Check ID. Older nonterminal leases are cancelled once, while
terminal history remains immutable to keep API work constant per attempt. A compact lease
identity acts as a fail-closed Matrix barrier, and every derived
mutation revalidates the exact latest Check ID, App, head, status, and attempt token. The verified full plan updates that
generation while preserving its provisional attempt identity, applies labels, and changes to the exact Classification
identity only when completing it successfully as the final mutation. Disabled Classification completes an existing lease successfully as an
explicit disabled result. Read, planning, or apply failures finalize the owned lease as failure when it has not been
superseded; inability to report still leaves a pending barrier rather than preserving stale success.
If the initial Check inventory itself fails, Control best-effort creates an emergency attempt generation before
propagating that read error; this deliberate failure-path write takes precedence over disabled zero-write behavior.

An apply failure carries the plan ID, failed desired digest, completed receipts and an `unknown` outcome. Callers must
discard that execution attempt, read fresh live state and replan; they must never resume or blindly replay a stale
plan. Label intents carry successive label-set digests, and comment deletion retains its resource-specific observed
body digest. The REST lease protocol is fail-closed but is not a cross-runtime atomic lock; the transitional
Classification workflow therefore queues same-PR attempts without cancelling in-flight HTTP mutations, and the later
per-PR Durable Object owns central atomic coordination and delivery deduplication. A real local workerd smoke executes two complete Classification attempts and proves that the
second attempt repeats only lease start/completion, not already-converged label mutations, while never changing the
pull-request body.
