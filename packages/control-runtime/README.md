# Steward private Control runtime

This Worker is the private, versioned adapter around the runtime-neutral
`packages/control` kernel. It has no public route, exports no Durable Object,
and is the only central runtime intended to receive GitHub App or server-side
human credentials in later slices.

The immutable `/v1/reconcile` path still accepts only an internal
`runtime-probe`. Its successful receipt binds the work-item subject, delivery,
coordinator generation, Steward commit, actual Cloudflare Worker version,
version tag, and immutable upload timestamp. It does not self-assert a mutable
deployment or promotion lane; Coordinator routing configuration and Cloudflare
deployment readback own that evidence.

The additive `/v2/reconcile` path strictly parses three separate phases:
read-only `prepare`, one-intent `apply-next`, and read-only `recover`. It binds
the live head, default branch, Manifest blob/configuration, pull-request input,
complete canonical plan, ordered intent identity, execution principal,
recovery policy, and the exact Control version prepared for the plan.

The first real v2 handler is deliberately narrow: for a machine-authored pull
request it can prepare one fixed `copilot-review.request` human intent, request
only `copilot-pull-request-reviewer[bot]`, and recover an uncertain response
from live read-only evidence without blind replay. A successful GitHub request
remains `pending-external`; it is not treated as a completed review. Human
authors remain on the organization-native Copilot path, malformed evidence
fails closed, and an already requested or current-head Copilot review
converges without reading the human credential.

Before GitHub access, `apply-next` and `recover` require an exact immutable
Control revision match. App identity is read from GitHub, the installation and
numeric repository are rebound to the configured organization, and the App
token is repository-scoped with only `contents:read`, `metadata:read`, and
`pull_requests:read`. The separate `COPILOT_REVIEW_REQUEST_TOKEN` is read only
after live evidence still matches the prepared mutation. Non-rate-limited
request failures become `unknown`; recovery never receives a mutation client
or reads that credential.

Classification and DCO-advisory remain unsupported on v2 and return `501`.
There is no v2-to-v1 fallback. This slice does not implement the complete
Copilot gate, blocking-comment aggregation, automatic approval, or a new main
authorization gate. Coordinator still uses v1 until its independent v2 runner
slice is implemented and protected promotion evidence is complete.

Every upload must use the immutable tag `steward-<40-character-lowercase-commit>`.
Control derives the Steward commit from Cloudflare's version metadata and
fails closed when the tag is absent or malformed; there is no separately
configured commit variable that can drift from the uploaded version.

Only the fixed Copilot review request is a real mutation in this source slice.
No deployment or runtime routing change is implied by the repository code.

Durable Object lifecycle is deliberately hosted by `packages/coordinator`.
That separation lets this Worker use an immutable version uploaded into a
`100% stable / 0% candidate` deployment and later gradual promotion.
