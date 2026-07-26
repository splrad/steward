# Steward Coordinator

`steward-coordinator` is a stable, private Queue consumer and SQLite Durable
Object host. One object named from the numeric repository ID and pull request
number owns delivery deduplication, monotonic generations, dirty coalescing,
and fenced leases. The original `coordinator_schema.version=1`, object name,
base tables, phases, failure codes, and v1 RPCs remain unchanged.

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
the base coordinator retains a follow-up until every unresolved plan has been
made safe.

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
fails closed, and diagnostics expose only the count.

A proven `not-attempted` result returns its bounded `retryAfterSeconds` hint
to the caller; `stale-plan` returns `null`. The future v2 Queue runner must
apply that hint as Queue retry delay before acknowledgement. The v1 sidecar
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

The Queue consumer still uses the v1 probe path in this slice; the real v2
governance runner and mutation adapters remain disabled. The Worker uses
Cloudflare's declarative SQLite Durable Object `exports`
lifecycle. That makes its state lifecycle atomic and intentionally keeps it
out of Control's gradual deployment. Candidate routing is owner-controlled by
`CONTROL_CANDIDATE_REPOSITORY_IDS` plus
`CONTROL_CANDIDATE_VERSION_ID`; no webhook or Queue message can select a
version. The returned Control version metadata is checked before acknowledgement
because an invalid Cloudflare version override silently falls back to normal
traffic percentages.

Those two values are deliberately not persisted as dashboard-only Wrangler
variables: `keep_vars` remains false. A candidate deployment must pass both
values together, read them back, and verify the returned version receipt. Any
ordinary Coordinator deploy therefore clears a stale candidate pin and falls
safe to stable routing instead of silently preserving mutable control-plane
state.

The configured dead-letter queue has no automatic consumer in this foundation
slice. Poison messages therefore remain retained for explicit operator
inspection and replay instead of being acknowledged into a second, less
durable store. Runtime diagnostics must continue to report DLQ state as
`unavailable` until authenticated Queue metrics/readback are implemented.
