# Manifest

The Manifest module owns `.github/steward.json` loading, Schema v1 validation, normalization, and configuration digests.

Trust rules:

- repository metadata is read first;
- content is fetched only from the repository's current default branch;
- callers cannot supply a PR head or arbitrary ref;
- unknown fields and unsupported schema versions fail closed;
- classification decisions explicitly map conventional types, docs-only paths, public-label rules, and fallbacks;
- secrets and tokens are not Manifest fields;
- object keys and identity sets are canonicalized, while arrays with policy order are preserved;
- the asynchronous SHA-256 configuration digest is computed from canonical UTF-8 JSON with Web Crypto;
- Content API base64 is decoded through a strict UTF-8 boundary without Node `Buffer` replacement semantics.

The module's text, base64, and digest primitives use `TextEncoder`, fatal `TextDecoder`, `atob`/`btoa`, and Web Crypto so the same protocol bytes run in Node 24 and standards-based Worker runtimes. Canonicalization remains limited to validated Steward Manifests; it is not a general JSON canonicalization scheme.

GitHub access is represented by `ManifestRepositoryClient`. Tests use an in-memory implementation; the real REST adapter belongs in the GitHub package.
