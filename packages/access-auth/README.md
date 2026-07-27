# Cloudflare Access authentication

`access-auth` is the shared Worker-compatible verifier for Steward endpoints
protected by Cloudflare Access Service Auth.

It validates the exact Access team issuer, policy audience, RS256 signature,
service-token Client ID, and service-principal claim shape. JWKS responses are
bounded and strictly prevalidated as RSA signing keys. Verified JWKS bytes are
cached per fetch implementation and team domain, while each request creates a
new resolver so cancellation remains bound to the caller.

`verifyCloudflareAccessPrincipal` returns the authenticated service Client ID
for authorization and audit ledgers. `verifyCloudflareAccessRequest` preserves
the existing `authorized | denied | unavailable` decision API for callers that
do not need the principal.

The verifier follows redirects manually and rejects every non-2xx response. It
does not authorize users, mutate Cloudflare configuration, or hold a Cloudflare
API token.
