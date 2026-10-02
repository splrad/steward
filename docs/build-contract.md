# Build contract

The core build contract supports `dotnet-assets-v1`, `node-package-v1`,
`oci-image-v1`, and `custom-adapter-v1`. `planBuild` validates each profile's
typed inputs and output rules, freezes the repository and commit identities,
and hashes the canonical inputs. Plans specify the runner family, a 45-minute
timeout, read-only repository permissions, no protected environment, and no
persisted Git credentials.

The runner adapter calls `validateBuildInputs` before execution to check source
paths and the separate output directory. A custom entrypoint must be a regular
file under `tools/`. Paths use portable relative syntax; traversal, links, and
Windows device names fail validation.

After execution, `collectFileBuildManifest` enumerates the output directory,
matches every file to exactly one declared rule, and computes its size and
SHA-256 from the actual bytes. Limits are 128 files, 1 GiB per file, and 4 GiB
in total. Empty files, extra files, conflicting names, links, and changes during
inspection fail validation. A versioned file build requires a native version
inspector implemented by the central adapter. The inspector reads the artifact
format from the supplied bytes; producer-supplied version claims are insufficient.

`collectOciBuildManifest` reads an OCI image layout and verifies every referenced
manifest, config, and layer against its declared digest and size. Output labels
identify the declared image rules. The image platforms must match the plan, and
the config's `org.opencontainers.image.version` label must match the public
version. Multi-platform images retain their image-index digest.

The collectors recheck every file's identity and metadata after the whole
collection pass, including OCI layout metadata and blobs. OCI total-size limits
include the layout and index files. Shared layers reuse verified digest and size
records without retaining their bytes, and leaf descriptors must agree with
their image configs on OS and architecture.

`canonicalBuildManifest` validates and serializes the standard manifest with
fixed field order, artifacts sorted by logical ID, and a final LF.
`parseBuildManifest` rejects duplicate keys, invalid UTF-8, unknown contract
fields, and invalid field types. The JSON Schema is
`schema/build-manifest.schema.json`; cross-field, path, and total-size checks
also require the core validator.

Consumers call `verifyDownloadedFileBuild` or `verifyDownloadedOciBuild` to
recompute the manifest and compare all identity fields and artifacts with the
expected manifest. `selectDeliveryBuilds` deduplicates active delivery references.
`deliveryBuildReadiness` blocks only deliveries that depend on a failed build;
a deployment sourced from a GitHub Release also depends on that release being
ready. A release with no build references is ready without assets.

These modules define and validate the handoff contract. Workflow execution,
toolchain setup, artifact upload and download, and delivery activation require
the orchestration layer to enforce the plan and call these validators.
