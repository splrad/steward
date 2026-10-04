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
Windows device names, including COM and LPT names with superscript digits
¹, ², and ³, fail validation. Output templates are checked again after version
expansion, with wildcard matching preserved. Missing paths, non-directory
components, and symbolic-link loops fail with `RN_BUILD_PATH`; other filesystem
errors propagate unchanged.

After execution, `collectFileBuildManifest` enumerates the output directory,
matches every file to exactly one declared rule, and computes its size and
SHA-256 from the actual bytes. Limits are 128 files, 1 GiB per file, and 4 GiB
in total. Empty files, extra files, conflicting names, links, and changes during
inspection fail validation. The reader opens artifacts in nonblocking mode where
the platform supports it, then verifies the opened file's identity before reading.
A versioned file build requires a native version inspector implemented by the
central adapter. The inspector reads the artifact
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

OCI JSON metadata is limited to 512 KiB before reading, both by descriptor and
actual file size. Reads stop at the observed size plus one byte to detect growth.
Layers use bounded chunks and retain the separate file-size limit. OCI metadata
accepts legal JSON escape sequences in commands and history while retaining
UTF-8, duplicate-key, and finite-number checks. Metadata roots must be objects;
null, arrays, and scalar roots fail with `RN_BUILD_INVALID`. Contract strings keep their
stricter character policy. File digests are fixed before native version inspection,
so an inspector changing its buffer cannot change the digest of the disk bytes.

File artifacts use the same bounded reader as OCI metadata. File contents are
retained only when the plan has a public version and a native version inspector
is supplied. Builds without a public version skip the inspector and still
verify file digests and metadata. Source and output
directories may have different Windows drive roots; equal or nested directories
remain invalid. OCI config OS and architecture fields must be strings even when
the descriptor omits its optional platform field.

`canonicalBuildManifest` validates and serializes the standard manifest with
fixed field order, artifacts sorted by logical ID, and a final LF. Both generation
and parsing enforce a 512 KiB UTF-8 limit, including that final LF.
Sparse platform and artifact arrays fail validation at their respective entry points.
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
