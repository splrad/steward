# Thin workflow templates

Repository-local event entrypoints generated with a complete Steward commit SHA.

These are generator inputs, not files to copy directly: each selected template contains one `__STEWARD_SHA__` marker that `steward init` replaces with the requested immutable commit. The generated feature-dependent files belong in the consumer repository's `.github/workflows/` directory without renaming. They contain only native event routing, stable runtime facts, read-only `GITHUB_TOKEN` permissions, and explicit repository Variable/Secret mappings; policy remains in the default-branch Manifest and Steward.
