# Steward private Control runtime

This Worker is the private, versioned adapter around the runtime-neutral
`packages/control` kernel. It has no public route, exports no Durable Object,
and is the only central runtime intended to receive GitHub App or server-side
human credentials in later slices.

The foundation version accepts only an internal `runtime-probe`. Every real
pull-request reconcile fails closed with `501` until its live GitHub handler is
implemented. A successful receipt binds the work-item subject, delivery,
coordinator generation, Steward commit, actual Cloudflare Worker version,
version tag, and immutable upload timestamp. It does not self-assert a mutable
deployment or promotion lane; Coordinator routing configuration and Cloudflare
deployment readback own that evidence.

Every upload must use the immutable tag `steward-<40-character-lowercase-commit>`.
Control derives the Steward commit from Cloudflare's version metadata and
fails closed when the tag is absent or malformed; there is no separately
configured commit variable that can drift from the uploaded version.

Real GitHub mutation remains prohibited in this slice. Before enabling it,
Control must use generation-bound idempotency/preconditions and return a
durable mutation receipt so a timed-out or superseded invocation cannot repeat
irreversible work.

Durable Object lifecycle is deliberately hosted by `packages/coordinator`.
That separation lets this Worker use an immutable version uploaded into a
`100% stable / 0% candidate` deployment and later gradual promotion.
