# Thin workflow templates

Repository-local event entrypoints generated with a complete Steward commit SHA.

Copy the four workflow files into the consumer repository's `.github/workflows/` directory without renaming them. The files contain only native event routing, stable runtime facts, read-only `GITHUB_TOKEN` permissions, and explicit repository Variable/Secret mappings; policy remains in the default-branch Manifest and Steward.
