# Manifest

The Manifest module owns `.github/steward.json` loading, Schema v1 validation, normalization, and configuration digests.

Trust rules:

- repository metadata is read first;
- content is fetched only from the repository's current default branch;
- the public repository-loading APIs resolve metadata internally and never accept a caller-selected PR head or ref;
- `bindDefaultBranchManifest` returns repository metadata with a validated default-branch value plus a zero-argument
  loader that captures that branch by value, allowing Control to establish live subject identity before it fetches
  Manifest content and preventing later callers from supplying another ref;
- `loadDefaultBranchManifestContext` invokes that binding and returns the exact metadata/Manifest pair when callers
  need both immediately; `loadDefaultBranchManifest` is its Manifest-only convenience wrapper;
- unknown fields and unsupported schema versions fail closed;
- classification decisions explicitly map conventional types, docs-only paths, public-label rules, and fallbacks;
- secrets and tokens are not Manifest fields;
- object keys and identity sets are canonicalized, while arrays with policy order are preserved;
- the asynchronous SHA-256 configuration digest is computed from canonical UTF-8 JSON with Web Crypto;
- `verifyLoadedManifest` reparses both the object and canonical JSON, recomputes the digest, and returns a private
  normalized copy so post-load object mutation cannot reuse stale evidence;
- Content API base64 is decoded through a strict UTF-8 boundary without Node `Buffer` replacement semantics.

The module's text, base64, and digest primitives use `TextEncoder`, fatal `TextDecoder`, `atob`/`btoa`, and Web Crypto so the same protocol bytes run in Node 24 and standards-based Worker runtimes. Canonicalization remains limited to validated Steward Manifests; it is not a general JSON canonicalization scheme.

GitHub access is represented by `ManifestRepositoryClient`. Tests use an in-memory implementation; the real REST adapter belongs in the GitHub package.
