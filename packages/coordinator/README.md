# Steward Coordinator

`steward-coordinator` is a private Queue consumer and SQLite Durable Object
host with two independent object classes:

- one pull-request object, named from the numeric repository ID and pull
  request number, owns delivery deduplication, monotonic generations, dirty
  coalescing, and fenced leases for one pull request;
- one repository fan-out object, named only from the numeric repository ID,
  owns bounded `all-open` enumeration and deterministic dispatch to the
  pull-request objects.

The original pull-request `coordinator_schema.version=1`, object name, base
tables, phases, failure codes, and v1 RPCs remain unchanged. Repository fan-out
uses a separate `RepositoryFanoutCoordinator` SQLite export and separate
schema, so its repository-scoped lifecycle cannot collide with a pull-request
object or alter the v1/v2 rollback state.

The Queue reader accepts strict `ScopeWorkItem V1` repository envelopes and
pull-request work-item schema versions 1, 2, and 3. Work-item v1 retains its
original `pull_request`-only event contract; v2 adds direct pull-request
review, review-comment, and review-thread triggers. A v3 item is a
repository-fan-out child whose `scope-fanout` cause binds the canonical root
scope delivery, repository fan-out generation, and pull request number. None
of these paths stores webhook bodies or changes the pull-request object's
level-triggered reconcile semantics.

An independent `coordinator_mutation_schema.version=1` sidecar stores a bounded
canonical v2 Control plan, its resolved current-head/Manifest identity,
prepared Control revision, ordered intents, dispatch evidence, and mutation or
recovery receipts. It never stores a raw webhook, GitHub response, credential,
comment body, or lease token, and its public diagnostic snapshot omits the
canonical plan. Old Coordinator code ignores the additive tables, so rollback
continues to read and write the original delivery state.

The Queue consumer claims a generation, invokes `steward-control` through a
private service binding outside the Durable Object transaction, and then
completes or fails the fenced lease. Duplicate, concurrent, redelivered, and
out-of-order messages are safe because every Control generation must perform a
fresh level-triggered reconcile. Control invocation has a deadline shorter
than the lease. Fencing protects coordinator state, but it is not by itself a
GitHub side-effect lock.

Before any future external write, the sidecar must first persist the complete
prepared plan and mark exactly one ordered intent as in-flight while renewing
the lease. A confirmed receipt is recorded before advancing. A timeout,
malformed response, stale lease, or lost Control response after dispatch
becomes `unknown`; that intent can only enter read-only recovery under a newer
generation and is never blindly replayed.

While any `unknown` or `recovering` plan remains, later generations cannot
persist a new plan or dispatch a new write. Recovery is fenced to the oldest
unresolved plan, repeated recovery begins are idempotent for that plan, and
the base coordinator always retains a follow-up after recovery. The triggering
event is then freshly prepared under a new generation before acknowledgement,
so recovery evidence for an older write cannot swallow a newer review event.

Human-principal dispatch also reserves an independent durable fence keyed by
the numeric repository/PR object, exact head SHA, and mutation type before
Control can be called. This enforces at most one request such as
`copilot-review.request` for the same head even after plan-history pruning,
rollback, eviction, redelivery, or a force-push back to an older head. A
different human mutation type or a genuinely new head remains eligible.
The reservation is released only when Control proves the write converged
without being attempted, or returns `not-attempted`/`stale-plan`; `applied`,
`unknown`, recovery `converged`, and `action-required` retain it. These
credential-free fences are not age-pruned. Their independent 128-entry bound
fails closed, and diagnostics expose only the count. A repeated same-head
request or an exhausted fence ledger is persisted as `action-required` and the
current delivery is completed; neither condition is converted into a blind
Queue retry.

A proven `not-attempted` result returns its bounded `retryAfterSeconds` hint
to the caller; `stale-plan` returns `null`. The v2 Queue runner applies that
hint as Queue retry delay before acknowledgement. The v1 sidecar
does not persist a not-before timestamp: if the RPC response is lost, durable
follow-up state plus normal Queue redelivery preserves the work and safety,
while only the optimized backoff is lost.

Recovery alone may use a replacement installation ID or a renamed/case-changed
repository full name: it is strictly read-only and must rebind fresh App scope.
The current lease generation and delivery, operation, numeric repository ID,
pull request number, old resolved plan context, plan identity, and exact
Control revision remain mandatory. Apply-next continues to bind the original
prepared work item exactly.

Sidecar terminal state and the base delivery completion/follow-up transition
are committed in one Durable Object SQL transaction. An undispatched plan can
be abandoned safely; a recovered prefix with remaining work is explicitly
superseded and freshly replanned; a known unsafe human action cancels the
undispatched suffix as `action-required`. Constructor and alarm audits also
repair an in-flight sidecar left behind while an older rollback version only
expired the base lease.

Coalesced Queue messages are acknowledged after the PR object's dirty state is
durably recorded. The active root immediately claims and runs the follow-up
generation, so a burst does not consume one Queue retry per event or create
false dead-letter poison. One invocation is bounded to eight immediate
follow-ups. If more work remains, Coordinator first persists a fresh wakeup to
the same Queue and only then acknowledges the completed root. A failed wakeup
write retains the root for retry, so an interleaved event stream cannot exhaust
one message's retry budget and strand a dirty object.

## Repository fan-out

Ingress repository lifecycle events enter Queue as a strict
`ScopeWorkItem V1` with `scope-reconcile` / `repository` / `all-open` scope.
The repository object durably selects a root delivery, generation, dirty
follow-up state, and fenced lease before enumeration. Control then performs
one live GitHub App page read per invocation; network I/O stays outside Durable
Object transactions. Pagination is bounded to 100 pull requests per page and
30 pages per pass.

The object persists canonical page receipts and membership for two complete
passes. Dispatch begins only when both passes prove the same live repository
identity, total count, complete pull-request set, and Control revision. Drift
restarts the bounded scan instead of treating a partial or unstable view as
authoritative. An explicit live absence is a stable empty/tombstone result;
installation suspension, rate limits, ambiguous GitHub failures, and other
unavailable states remain retryable and are never collapsed to empty.

Each confirmed open pull request becomes a `WorkItem V3`. Its delivery ID is
derived from the canonical root scope, repository fan-out generation, and pull
request number, and Coordinator recomputes that identity before enqueueing it.
Dispatch uses bounded Queue `sendBatch` calls. After a successful batch write,
the repository object durably confirms the exact target delivery IDs before
advancing. If the response or confirmation is lost, retry sends the same
deterministic IDs; the downstream pull-request object deduplicates them rather
than creating a second logical reconciliation. A dirty repository event is
retained as a later generation and cannot be swallowed by completion of the
active one.

The Queue consumer routes existing schema-v1 work items through the unchanged
Control v1 probe path, so already queued messages and the deployed rollback
reader keep their original behavior. Schema-v2 work items use the strict
Governance v2 runner: recovery is attempted first, `prepare` is persisted in
the sidecar before any mutation, each `apply-next` receipt is recorded before
advancing, and an uncertain response becomes `unknown` for read-only recovery.
Schema-v3 fan-out children use the same strict Governance v2 runner.
Classification and DCO v2 remain disabled in Control; this runner does not
silently fall back to v1 for a v2 or v3 work item. Direct v1/v2 producer and
rollback contracts remain unchanged.

The Worker uses Cloudflare's declarative SQLite Durable Object `exports`
lifecycle. That makes its state lifecycle atomic and intentionally keeps it
out of Control's gradual deployment. Candidate routing is owner-controlled by
`CONTROL_CANDIDATE_REPOSITORY_IDS` plus
`CONTROL_CANDIDATE_VERSION_ID`; no webhook or Queue message can select a
version. Prepare verifies an owner-selected candidate when configured, while
apply and recovery pin the exact version recorded by the prepared receipt.
Returned Control version metadata is checked before acknowledgement because an
invalid Cloudflare version override silently falls back to normal traffic
percentages.

The first release containing `RepositoryFanoutCoordinator` adds a new Durable
Object export and therefore requires a reviewed full Coordinator deploy; it
must not be introduced through the normal gradual version-upload path. Rollout
must first deploy a compatible Control repository-fan-out page endpoint, then
fully deploy Coordinator with the new repository export and both Queue routes,
and only then deploy the Ingress `ScopeWorkItem V1` writer. After sandbox and
canary evidence prove the complete path, the GitHub App repository event may
be enabled. Until that final owner action, repository events do not enter this
path.

The existing pull-request v2 order remains unchanged: Control
dual-read/strict v2 first, Coordinator dual-route second, then Ingress v2, and
only after canary evidence may the GitHub App add review-event subscriptions.
Source integration alone is not live runtime activation, and this document
does not claim that the repository export has been deployed or that the App
repository event has been enabled.

Those two values are deliberately not persisted as dashboard-only Wrangler
variables: `keep_vars` remains false. A candidate deployment must pass both
values together, read them back, and verify the returned version receipt. Any
ordinary Coordinator deploy therefore clears a stale candidate pin and falls
safe to stable routing instead of silently preserving mutable control-plane
state.

The deployed foundation still has no dead-letter consumer. The current source
adds the separate Access-protected Recovery Worker: it captures
`steward-events-dlq` into its SQLite ledger before acknowledging a message,
and routes repeated capture failures to `steward-recovery-capture-dlq`.
Authenticated diagnostics checks both queues, while replay remains an explicit
operator action through the Recovery plane. None of that topology is live
until the reviewed Recovery Durable Object deployment and its Queue bindings
are completed.
