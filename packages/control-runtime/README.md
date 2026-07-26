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
recovery policy, and the exact Control version prepared for the plan. The real
governance handler is intentionally not present yet. Mutation phases first
revalidate the persisted bytes with the existing strict Control-plan verifier,
then return before any GitHub token or network adapter is used. There is no
v2-to-v1 fallback and no empty-plan success.

The v2 transport vocabulary already reserves the `governance` objective and
`human` execution principal. The current semantic plan kernel remains contract
v1: classification and DCO-advisory mutations executed by an installation.
An envelope that is valid at the core transport layer but unsupported or
inconsistent under that semantic contract returns `400`; a semantically valid
operation whose real handler is not implemented returns `501`. A later handler
slice must extend the semantic kernel before enabling the reserved transport
forms.

Every upload must use the immutable tag `steward-<40-character-lowercase-commit>`.
Control derives the Steward commit from Cloudflare's version metadata and
fails closed when the tag is absent or malformed; there is no separately
configured commit variable that can drift from the uploaded version.

Real GitHub mutation remains prohibited in this slice. The v2 contract and
Coordinator sidecar provide the required pre-mutation plan boundary, but the
next handler must still apply at most one persisted intent per call, verify its
prepared Control version before GitHub I/O, and use live-only recovery after an
unknown response.

Durable Object lifecycle is deliberately hosted by `packages/coordinator`.
That separation lets this Worker use an immutable version uploaded into a
`100% stable / 0% candidate` deployment and later gradual promotion.
