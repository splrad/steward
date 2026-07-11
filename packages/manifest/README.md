# Manifest

The Manifest module owns `.github/steward.json` loading, Schema v1 validation, normalization, and configuration digests.

Trust rules:

- repository metadata is read first;
- content is fetched only from the repository's current default branch;
- callers cannot supply a PR head or arbitrary ref;
- unknown fields and unsupported schema versions fail closed;
- secrets and tokens are not Manifest fields;
- object keys and identity sets are canonicalized, while arrays with policy order are preserved;
- the SHA-256 configuration digest is computed from canonical UTF-8 JSON.

GitHub access is represented by `ManifestRepositoryClient`. Tests use an in-memory implementation; the real REST adapter belongs in the GitHub package.
