# Build contract

## 当前产品构建接口（E05）

产品在合并源码 `S` 的 `steward-release-publish.yml` 中直接执行构建命令。入口读取受保护 Git 记录和当前原生 Run，核对 canonical Run、App bot、构建 ref、`S`、控制器 `R`、冻结候选身份和实际失败预算。未绑定或读取未知返回 75；产品命令开始前拒绝不匹配的来源。

`.github/delivery.json` 只声明作者 ID、单位路径、说明路径、资产和渠道位置；命令和构建参数属于产品 YAML。`build` 记录不依赖 Release ID。各单位的原生版本、tag、资产全集、工具锁和实际 Run/attempt 分别冻结，中央共享任务负责原生元数据检查、SBOM、说明渲染与 N+4 封装。只有 freeze 作业获得 attestation/OIDC 权限。

恢复按原生 artifact ID 读取完整冻结集合，检查摘要和 manifest，保留原 producer Run/attempt。同 attempt、后续 attempt 和有明确前驱的 continuation 都可读取已完成的 freeze。发现多套冻结集合、异源或缺少可读字节时停止；正式 Release 的补缺和历史读取由 E06 接入。当前 LayerScape 使用 Windows x64、PE/DLL ZIP 和真实字体 ZIP 检查；其他生态仍需对应原生包格式的接入验收。

下文保留已有收集器和历史执行合同，供 E06–E13 逐项交接。当前产品入口已移除通用构建解释器及旧 `release-admission` CLI。

The core build contract supports `dotnet-assets-v1`, `node-package-v1`,
`oci-image-v1`, and `custom-adapter-v1`. `planBuild` validates each profile's
typed inputs and output rules, freezes the repository and commit identities,
and hashes the canonical inputs. Core plans specify a neutral `runnerFamily`
(`windows` or `linux`) and a 45-minute timeout. The runner adapter
`githubBuildExecutionPolicy` maps that family to `windows-latest` or
`ubuntu-latest` and sets read-only repository permissions, no protected
environment, and no persisted Git credentials.

The .NET profile always uses the Windows runner family, including when its
target runtime is `linux-x64`. The target RID does not select the execution OS.
Versioned outputs on Linux and Windows support `package.json`, Python wheels,
and Python source distributions (`.tar.gz`). Other Linux native formats fail
explicitly during version inspection.

The Python reader runs from the reviewed controller's `tools/template/.venv`
with Python isolated mode. The `release-inspection` dependency group shares
the existing `tools/template/uv.lock` and installs only `packaging`. Both the
product evidence workflow and `npm test` prepare that group with frozen uv sync.
The test preparation uses `--inexact` to retain dependencies already installed
for template work in the same environment.
The reader uses `packaging` to compare the filename, wheel metadata directory,
and embedded Name/Version. It reads the collector's private hashed snapshot
without importing or extracting artifact code. Limits are 4,096 entries,
512 KiB metadata, a 1 MiB ZIP read allocation, and 256 MiB expanded contents
(including all gzip output, tar headers, and padding). Unsafe paths, links,
duplicate entries, malformed metadata, and inconsistent names or versions fail.

The returned PEP 440 version must equal the planned `packageVersion`. For an RC,
public `1.2.4-rc.1` and native `1.2.4rc1` remain distinct fields. This reader
validates a supplied identity; the release orchestration must first obtain the
native package version from the merged source and project public versions
through the product's release mechanism. Python RP/source identity and a real
product release still need their own integration acceptance.

The runner adapter calls `validateBuildInputs` before execution to check source
paths and the separate output directory. A custom entrypoint must be a regular
file under `tools/`. Paths use portable relative syntax; traversal, links, and
Windows device names, including COM and LPT names with superscript digits
¹, ², and ³, fail validation. Output templates are checked again after version
expansion, with wildcard matching preserved. Missing paths, non-directory
components, and symbolic-link loops fail with `RN_BUILD_PATH`; other filesystem
errors propagate unchanged.
Resolved files must remain inside their own root, including on Windows across
drive letters. Directory enumeration streams entries and closes the handle when
file or directory limits stop collection.

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
Normalized OCI repositories and manifest references share a pure data syntax check
based on the [Distribution reference grammar](https://github.com/distribution/reference/blob/main/regexp.go).
Repository components start and end with lowercase letters or digits, with
supported separators between them. Empty path components and names such as
`.github` fail OCI repository validation. Core plans preserve the source
repository identity. The runner maps source names to lowercase by default and
accepts an explicit normalized repository from the catalog or calling adapter,
so a source such as `example/.github` can use an independent registry namespace.
Collection and download verification accept the same repository mapping and
compare the resulting manifest references.
Registry hosts support bracketed IPv6 addresses and optional ports. Tags retain
case, including uppercase letters. References use SHA-256 digests and must
match the artifact digest. Remote repository names are limited to 255 characters.

The collectors recheck every file's identity and metadata after the whole
collection pass, including OCI layout metadata and blobs. OCI total-size limits
include the layout and index files. Shared layers reuse verified digest and size
records without retaining their bytes. Leaf descriptors must agree with their
image configs on OS and architecture. An index descriptor with a platform
declaration must contain that OS and architecture throughout its subtree;
indexes without a platform declaration may contain multiple planned platforms.

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
is supplied. This path has a separate 32 MiB per-file limit, checked before
opening the artifact; larger files fail with `RN_BUILD_LIMIT`. Retained bytes
use one allocation. Unversioned hashing keeps the existing 1 GiB per-file limit. Builds without a public version skip the inspector and still
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
expected manifest. Finite delivery data uses `assertDeliveryArtifactMapping` to
check unique producer and asset IDs, exact per-producer asset sets, and producer
references. `assertDeliveryPath` and `assertDeliveryAssetName` validate repository
paths and flat portable filenames.

These modules define and validate the handoff contract. Workflow execution,
toolchain setup, artifact upload and download, and delivery activation require
the orchestration layer to enforce the plan and call these validators.
