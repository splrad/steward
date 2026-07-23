# Steward Coordinator

`steward-coordinator` is a stable, private Queue consumer and SQLite Durable
Object host. One object named from the numeric repository ID and pull request
number owns delivery deduplication, monotonic generations, dirty coalescing,
and fenced leases. It stores no GitHub object snapshot, raw webhook body,
credential, Control plan, or mutation receipt.

The Queue consumer claims a generation, invokes `steward-control` through a
private service binding outside the Durable Object transaction, and then
completes or fails the fenced lease. Duplicate, concurrent, redelivered, and
out-of-order messages are safe because every Control generation must perform a
fresh level-triggered reconcile. Control invocation has a deadline shorter
than the lease. Fencing protects coordinator state, but it is not by itself a
GitHub side-effect lock; real mutation remains disabled until Control adds
generation-bound idempotency and preconditions.

Coalesced Queue messages are acknowledged after the PR object's dirty state is
durably recorded. The active root immediately claims and runs the follow-up
generation, so a burst does not consume one Queue retry per event or create
false dead-letter poison. One invocation is bounded to eight immediate
follow-ups. If more work remains, Coordinator first persists a fresh wakeup to
the same Queue and only then acknowledges the completed root. A failed wakeup
write retains the root for retry, so an interleaved event stream cannot exhaust
one message's retry budget and strand a dirty object.

The Worker uses Cloudflare's declarative SQLite Durable Object `exports`
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
