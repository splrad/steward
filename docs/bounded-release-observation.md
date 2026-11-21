# 固定对象发行观察

三固定入口在 job 层提前要求 inputs.policy_sha == github.sha 且 github.workflow_sha == github.sha，使旧 policy 或不同 workflow 来源在 runner、依赖安装和秘密注入前跳过；运行时对当前 main、controller、native Run 的原生核验仍全部保留。跳过无 artifact 不表示完成，消费者按原有限确认和 deadline 收束，不重复 POST。该前置门槛不修复排队后的 main 漂移，后者仍由运行时拒绝。

`config/bounded-recheck.json` 已将 `enabled` 设为 `true`，以 `deploymentSha` 指定对应的维护提交。该配置允许通过既有身份与版本校验的显式调用；三个入口仍仅由 `workflow_dispatch` 触发。采用变更须核对当前 Worker、产品默认分支、在途事件和旧注册。中央主线通过 Native Validation 与 Governance Promotion 后，使用已晋级控制器、相应维护提交和实际产品提交完成 Worker 换版，并回读绑定、旧注册状态和窗口内的真实事件。

## 候选链

现役 Worker 验签产品 webhook，解析准确原生 issue event 后，持久登记一次派发意图；只派发中央 `bounded-release-event.yml`，输入 `event_json/request_key/policy_sha`。`event_json` 严格为 `{repositoryId:1187527897,prNumber,eventId}`。中央入口核对固定仓库、默认分支、准确 workflow SHA、App bot 原生 Run 和当前入口开关。

中央从不可变 release-state commit 读取并校验 Git blob、分块文档摘要、候选 PR 和原生 issue event，输出 `bounded-recheck-registration-<request_key>/registration.json`：

- `schemaVersion:1`、`requestKey`、`registration:{identity,t0,policySha,deploymentSha}`。
- `producer:{repositoryId:1296724484,runId,attempt,controllerSha}`。
- `sourceEvidence:{stateCommit,path,documentDigest,prNumber,head,eventId,eventCreatedAt}`。

Worker 是唯一完成消费者，按原意图的有限 GET 确认 producer、attempt、artifact 摘要和原 Git 事实。中央不使用 self `workflow_run`，不向 Worker 发起第二次完成回调。未知派发不得重复 POST。Worker 对已登记对象按真实标签事件执行 CAS pause/resume，保留原 T0、截止时间、预算与未知意图；重复登记不产生新窗口。`applyCandidateEvent` 是该协议的纯函数参照，中央工作流不调用它。

身份字段为 `repositoryId/cycleId/channel/version/artifactDigest/sourceSha/stage/epoch/upstreamPR`。候选 `channel/stage=candidate`、`upstreamPR=null`；`cycleId=candidate.id`；`artifactDigest=sha256:<SHA256(JSON.stringify(generated))>`；`sourceSha=candidate.baseSha`；epoch 为 `SHA256(JSON.stringify([repositoryId,candidate.id,candidate.baseSha,candidate.generatedSnapshotPath,candidate.publishedHead]))`。人工 head、投影和 state revision 不重置代际。

Worker 固定派发 `release-observe.yml`，仅接受 `identity_json/request_key/policy_sha`，run-name 为 `Observe candidate <request_key>`。它与现役候选及周期入口共用串行组。入口必须已有完整生成缓存、原生身份缓存且无 pending 写；源码变化返回 `SOURCE_CHANGED`，关闭或已合并 PR 停止。只刷新受保护投影和 bot 状态评论，保留人工稿、生成快照与候选分支，不进入生成、模型、构建、合并或发布。

## 正常候选事件与暂停交接

`release-candidate-event.yml` 是与 timer 分离的普通候选入口。Worker 对真实产品 webhook 验签并持久化唯一事件意图，解析准确原生 issue event 后，以 `event_json/source_sha/request_key/policy_sha` 派发。事件仅接受现有固定候选 PR 的 `release:editing` labeled/unlabeled 或 reopened；本入口不宣称覆盖 main push、构建完成、Pages 或质量结果事件。

入口原生复核固定仓、原事件、当前标签、准确 PR、源 SHA、Run/workflow 身份和当前控制器，然后只执行 `nativeReleaseCandidate` 普通候选路径；不执行全仓协调器、发布周期服务或 merged-cycle handoff。源在处理中变化即停止，原生写入仍通过既有 CAS 和人工差异保护。合法 `EDITING/HUMAN_EDIT_CONFLICT` 分别记录为暂停或人工保护，不强制生成新稿，也不等同当前源码及全部 E11 已通过。

正常结果 `candidate-event-<request_key>/result.json` 严格包含 11 字段：`schemaVersion/requestKey/producer/event/sourceSha/status/reason/outcome/stateBefore/stateAfter/candidateIdentity`。producer 为 `{repositoryId,runId,attempt,controllerSha}`，event 为 `{repositoryId,prNumber,eventId}`；reason 可 null，candidateIdentity 在未具备稳定缓存时可 null。Worker 独立核可信 Run、artifact 和原生事实后处理结果；只有当前生成缓存来源或已验证人工事实来源与当前 main 一致且缓存完整才进入有界观察登记。不能重写旧 epoch 来绕过 `SOURCE_CHANGED`。

现役入口核对当前 main、触发 Run、自身原生 workflow 状态及 `config.enabled`。Worker 继续按各入口现有开关受理。回退先关闭受影响的新入口与 Worker 写入，再保全原对象恢复记录。

结果 artifact 为 `candidate-observation-<request_key>/result.json`，字段为 `schemaVersion/requestKey/identity/repositoryId/runId/runAttempt/controllerSha/sourceSha/observedAt/status/reason/outcome/stateBefore/stateAfter`。Worker 必须独立核实结果和业务证据，Run success 本身不代表完成。

## WinGet

`bounded-winget-contract.mjs` 以受保护且已核验的原 cycle 为输入，只构造 layerscape/winget 单目标：

`cycle_id/source_sha/execution_sha/controller_sha/targets_json/mode/operation_key/request_key`，其中 mode 固定 observe。操作摘要沿用 `channelTargetsDigest`；request key 为 `SHA256(JSON.stringify(['observe',targetsDigest,executionSha]))`。DO 槽位键不得替代这个现有兼容字段。

首次登记由 Worker 核准确成功 submit Run、job、`channel-<requestKey>-layerscape-winget-<runId>-<attempt>/report.json` 及原生 upstream PR。PR 身份来自已核 submit item 的 `nativeObjectId`，T0 使用原生 PR `created_at`；合并后 index 阶段使用原生 merge 时间。仅凭可变请求体、名称搜索或 Run 成功不能登记。

index 复用 `probe-<cycleId>-<targetsDigest>-<runId>-<attempt>/report.json`，核原生 observe job、run/attempt、SHA、摘要、时间窗和准确 PR number/node_id。只有新鲜 `OK/exists/accepted/indexed` 且 `evidenceKind=github-pr:<registeredNumber>` 才满足索引完成。模板仅将 observe job 限制为 5 分钟，并避免 WinGet 单目标无关的 GHCR 登录；没有安装验证。

## 采用条件

中央与 Worker 最终源码、生产者接口及迁移记录须一致，固定策略 SHA、部署 SHA 和产品采用 SHA 须按正式配置核对。审查通过后按顺序采用中央和产品入口。固定观察遇新 main 时停止，正常事件入口按原候选更新和人工稿保护规则推进。

切换前确认旧工作流 311600220 保持手工停用，完整读取全部原生 Run 并确认均进入终态。停用后已开始的 Run 仍可继续执行，因此有运行未结束、状态无法确认或旧工作流被重新启用时，暂停采用。2026-11-21 读回四个旧 Run 全为 completed，最后一次为 [43500446376](https://github.com/splrad/steward/actions/runs/43500446376)。审查候选提交确认旧写者和定时入口缺席，合入后通过正常 Governance Promotion 晋级控制器，在真实候选、周期和 Pages 事件中验证新来源。历史 Run 保持可读。


## 人工完成稿的冻结事实

正常真实事件可在原候选已纳入准确 current main、仍未合并且没有 editing/pending 时，验证现有人工稿并冻结 `session.manualValidation`。该可选字段使用 `kind: validated-manual-candidate`；旧六字段 session 保持可读。旧 generated、baseSha、publishedHead、conflict 和失败记录不改。验证不调用模型、push、build 或 mergedSnapshot/verifyHandoff。

只支持固定 LayerScape `.` 单元及 `simple` / `VERSION` 适配器。真实 Git ancestry 必须证明 source 是 head 的祖先；同时枚举 source 到 head 的完整 Git 变更路径，只允许完整旧 G.files 中的受管路径及当前 notesPath，额外代码、workflow 或资产变化拒绝为 MANUAL_UNMANAGED_CHANGES；旧 G 非删除文件在 head 中必须仍为相同 mode 的普通 blob，删除项必须缺失（当前必需 notesPath 服从已核 notes 合同），结构失配拒绝为 MANUAL_MANAGED_STRUCTURE；合法人工正文允许不同，其全部 bytes 由 headSha 绑定，五文件事实格式保持不变；准确 head 中的 RP config、manifest、delivery、VERSION 与七节 notes 均实际读取并校验。普通 blob 使用严格 UTF-8 解码，文件摘要取原文；VERSION 只在版本比较时 trim。读取前后核 PR/head/source/state。快照严格绑定 repository/candidate/PR/branch，未知输入失败。

稳定事实按 `manualCandidateFacts` 的固定字段顺序序列化：kind、repositoryId、candidateId、prNumber、branch、headSha、sourceSha、units、files、projection。units 内依次 id/path/version/tag/notesPath，files 内 path/sha256 并按 path 字典序排序，projection 内 preview/bodyDigest。`factDigest=SHA256(JSON.stringify(facts))`；九字段 candidate identity 的 artifactDigest 为 `sha256:` 加此摘要，epoch 为 `SHA256(JSON.stringify([kind,candidateId,headSha,sourceSha,factDigest]))`。producer 的 repositoryId/runId/attempt/controllerSha/requestKey 仅为证据，不入 epoch。相同事实复用原 producer；固定观察失配不得 fallback 旧G或换对象。

normal 仍为原 11 顶层字段，人工验证成功使用 `status: READY`、`reason: MANUAL_VALIDATED`、`outcome: manual_validated`。它只冻结待办，不等于完成。重复 normal 在旧冲突处理之前重核并复用事实，不把已完成评论改回冲突提示。

人工观察恢复的实际待办为既有固定 candidate-status 评论及 preview。`projection.preview` 是内容部分；完整正文由 `manualCandidateBody` 确定：原 owner marker、准确候选 head、单位版本，再加 preview。只有 observer 才更新该派生结果并原生回读；相同结果无新增写入。人工完成使用 `READY / MANUAL_PROJECTION / done`。

observer artifact 在原严格顶层字段之外统一增加 `projectionEvidence`：G 与人工完成均必须为 `{commentId,bodyDigest,previewDigest}`。摘要分别对应完整评论与 preview。D 不得仅信 producer 的 outcome 或这些摘要：须独立核准确 PR、App bot、唯一 owner marker、完整正文、受保护 session.preview/statusCommentId，并重核 head/source/state。缺失、重复、API 未知或移动均不返回完成。

真实漏立即处理样本须保留登记前自然存在的评论/preview 差异，随后由真实 alarm 在原窗口完成；已经完成的重放不算恢复正例。本地 tests 不替代真实产品窗口或 E11 签收。


## 完整缓存、完成判据与控制器兼容

所有 mode 都要求 enabled=true 且 deploymentSha 为完整部署来源 SHA。generatedSnapshotPath 必须指向同一候选的 generated 归档；读取全部分块并核 owner/kind/digest、与 session.generated 内容深等，缺失或错配拒绝。人工事实同样保留并核对完整旧 G。

G 缓存观察先核对实际候选 head 的完整 tree 等于 G.baseSha 应用 G.files 的冻结结果，再通过 candidateProjectionPreview 恢复冻结 notes 与原生贡献者的既有 preview，以及 candidateStatusBody 固定评论并回读。人工将受管文件还原为 base 时，即使可合并也返回 WAIT/GENERATED_FILES_MISMATCH，保留候选文件且不写完成投影。只有 READY/CACHED_OBSERVATION 或 READY/MANUAL_PROJECTION 且原生投影证据完整才可 done。人工冲突保护仍会维护保护评论，但 outcome 为 needs_attention，不作为候选完成。

超过 48KiB 的原评论合同继续使用受保护 preview 的固定 GitHub blob 链接。复用旧链接前核其完整 commit SHA、准确 repository/候选路径、state 祖先及实际 blob 原文与最终 preview 一致；记录 statusCommentId 导致 state head 前进时不改写已经正确的链接。消费者独立重算正文，并读取链接实际指向的 immutable blob，不能仅相信当前 state 或任意 URL。

人工缓存原 producer 为历史证据，需按其准确 run/attempt/SHA 独立验证；当前执行 artifact 则绑定当前受审控制器。相同缓存可以在新控制器下真实重验并首次登记，不因历史 producer SHA 不同永久锁死。既有 DO 对象的 policySha/deploymentSha、epoch、T0、deadline 和 pending intent 仍保持原值；跨 pin 的已有对象明确停止，本变更不提供暗迁移、自动续窗或完整跨部署恢复。

## 固定产品发行

`release-cycle-event.yml` 在受保护的中央 main 运行，执行前核原生 App Run、当前 main、已晋级的 `steward/validated-controller` 及自身原生工作流。Worker 在产品 push 或已登记运行完成后传入 `event_json/request_key/policy_sha`。业务标识由原产品仓、事件种类和源 SHA 或 Run/attempt 派生。相同键复用同一入口。共享 concurrency 组串行处理发布、候选编辑和观察。

产品默认分支推进时，候选交接从已合并的准确 PR、审定树和 Git 祖先核对得到 S。构建在 `steward/build/<cycleId>` 运行，构建完成后由中央发布器使用原冻结资产。中央发布 Run 的完成回执只处理在受保护 Git 中登记的原始发布调用。渠道 submit/verify 完成后分别按原生运行和独立渠道证据更新；成功的 observe 回执不再请求 probe。每个运行的 `release-cycle-<request_key>-<run_attempt>/result.json` 保留生产者、事件、周期及是否调用过发布器。待处理、未知或失败状态按原对象恢复。

WinGet 首次提交使用 version、installer、defaultLocale 三个清单。消费步骤分别查询准确版本和默认版本，核对版本、安装器 URL 和 SHA-256，下载后核对大小与哈希。安装、安装后检查及卸载的验收分类均为 `EXCLUDED_BY_USER`。

采用时先晋级中央控制器并对齐 Worker，再将产品工作流固定到正式控制器。产品构建工作流 410998652 和渠道工作流 410998651 由发行负责人在获准窗口启用。回退时先停止新事件受理，保存原请求及 Git 证据并核对已发出的操作。
