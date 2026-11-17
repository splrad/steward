# 固定对象发行观察

当前入口默认关闭，`config/bounded-recheck.json` 的 `enabled:false` 与 `deploymentSha:null` 表示尚未连接。代码采用、Worker 部署、产品模板采用和真实事件接管分别验收。

## 候选链

现役 Worker 验签产品 webhook，解析准确原生 issue event 后，持久登记一次派发意图；只派发中央 `bounded-release-event.yml`，输入 `event_json/request_key/policy_sha`。`event_json` 严格为 `{repositoryId:1187527897,prNumber,eventId}`。中央入口只接受固定仓库、默认分支、准确 workflow SHA 和 App bot 原生 Run。旧入口预期暂停标记、旧写者停用状态或新入口开关不符合交接合同时停止。

中央从不可变 release-state commit 读取并校验 Git blob、分块文档摘要、候选 PR 和原生 issue event，输出 `bounded-recheck-registration-<request_key>/registration.json`：

- `schemaVersion:1`、`requestKey`、`registration:{identity,t0,policySha,deploymentSha}`。
- `producer:{repositoryId:1296724484,runId,attempt,controllerSha}`。
- `sourceEvidence:{stateCommit,path,documentDigest,prNumber,head,eventId,eventCreatedAt}`。

Worker 是唯一完成消费者，按原意图的有限 GET 确认 producer、attempt、artifact 摘要和原 Git 事实。中央不使用 self `workflow_run`，不向 Worker 发起第二次完成回调。未知派发不得重复 POST。Worker 对已登记对象按真实标签事件执行 CAS pause/resume，保留原 T0、截止时间、预算与未知意图；重复登记不产生新窗口。`applyCandidateEvent` 是该协议的纯函数参照，中央工作流不调用它。

身份字段为 `repositoryId/cycleId/channel/version/artifactDigest/sourceSha/stage/epoch/upstreamPR`。候选 `channel/stage=candidate`、`upstreamPR=null`；`cycleId=candidate.id`；`artifactDigest=sha256:<SHA256(JSON.stringify(generated))>`；`sourceSha=candidate.baseSha`；epoch 为 `SHA256(JSON.stringify([repositoryId,candidate.id,candidate.baseSha,candidate.generatedSnapshotPath,candidate.publishedHead]))`。人工 head、投影和 state revision 不重置代际。

Worker 固定派发 `release-observe.yml`，仅接受 `identity_json/request_key/policy_sha`，run-name 为 `Observe candidate <request_key>`。与原发行协调器共用串行组。入口必须已有完整生成缓存、原生身份缓存且无 pending 写；源码变化返回 `SOURCE_CHANGED`，关闭或已合并 PR 停止。只刷新受保护投影和 bot 状态评论，保留人工稿、生成快照与候选分支，不进入生成、模型、构建、合并或发布。

## 正常候选事件与暂停交接

`release-candidate-event.yml` 是与 timer 分离的普通候选入口。Worker 对真实产品 webhook 验签并持久化唯一事件意图，解析准确原生 issue event 后，以 `event_json/source_sha/request_key/policy_sha` 派发。事件仅接受现有固定候选 PR 的 `release:editing` labeled/unlabeled 或 reopened；本入口不宣称覆盖 main push、构建完成、Pages 或质量结果事件。

入口原生复核固定仓、原事件、当前标签、准确 PR、源 SHA、Run/workflow 身份和当前控制器，然后只执行 `nativeReleaseCandidate` 普通候选路径；不执行全仓协调器、发布周期服务或 merged-cycle handoff。源在处理中变化即停止，原生写入仍通过既有 CAS 和人工差异保护。合法 `EDITING/HUMAN_EDIT_CONFLICT` 分别记录为暂停或人工保护，不强制生成新稿，也不等同当前源码及全部 E11 已通过。

正常结果 `candidate-event-<request_key>/result.json` 严格包含 11 字段：`schemaVersion/requestKey/producer/event/sourceSha/status/reason/outcome/stateBefore/stateAfter/candidateIdentity`。producer 为 `{repositoryId,runId,attempt,controllerSha}`，event 为 `{repositoryId,prNumber,eventId}`；reason 可 null，candidateIdentity 在未具备稳定缓存时可 null。Worker 独立核可信 Run、artifact 和原生事实后处理结果；只有当前 candidate base 与当前 main 一致且缓存就绪才进入有界观察登记。不能重写旧 epoch 来绕过 `SOURCE_CHANGED`。

旧 `release.yml`（311600220）保持 `disabled_manually`，`STEWARD_EXPECTED_PAUSED_RELEASE` 继续为 `311600220`，保留健康检查的既有预期暂停语义。新入口独立受 `config.enabled`、Worker 开关和自身原生 workflow active 状态约束；缺任一项即停止。新入口不要求或允许为了接管而重启旧全仓写者。回退先关闭新入口/Worker，再保全原对象恢复记录，旧暂停标记保持。

结果 artifact 为 `candidate-observation-<request_key>/result.json`，字段为 `schemaVersion/requestKey/identity/repositoryId/runId/runAttempt/controllerSha/sourceSha/observedAt/status/reason/outcome/stateBefore/stateAfter`。Worker 必须独立核实结果和业务证据，Run success 本身不代表完成。

## WinGet

`bounded-winget-contract.mjs` 以受保护且已核验的原 cycle 为输入，只构造 layerscape/winget 单目标：

`cycle_id/source_sha/execution_sha/controller_sha/targets_json/mode/operation_key/request_key`，其中 mode 固定 observe。操作摘要沿用 `channelTargetsDigest`；request key 为 `SHA256(JSON.stringify(['observe',targetsDigest,executionSha]))`。DO 槽位键不得替代这个现有兼容字段。

首次登记由 Worker 核准确成功 submit Run、job、`channel-<requestKey>-layerscape-winget-<runId>-<attempt>/report.json` 及原生 upstream PR。PR 身份来自已核 submit item 的 `nativeObjectId`，T0 使用原生 PR `created_at`；合并后 index 阶段使用原生 merge 时间。仅凭可变请求体、名称搜索或 Run 成功不能登记。

index 复用 `probe-<cycleId>-<targetsDigest>-<runId>-<attempt>/report.json`，核原生 observe job、run/attempt、SHA、摘要、时间窗和准确 PR number/node_id。只有新鲜 `OK/exists/accepted/indexed` 且 `evidenceKind=github-pr:<registeredNumber>` 才满足索引完成。模板仅将 observe job 限制为 5 分钟，并避免 WinGet 单目标无关的 GHCR 登录；没有安装验证。

## 采用条件

中央与 Worker 最终源码、生产者接口及迁移/恢复记录须一致；Worker 固定策略 SHA、部署 SHA、产品采用 SHA 与中央配置相符。检查现有 App 精确仓库的 Actions 能力和暂停状态。先完成正常审查及必要检查，再由中央排序采用与启用。固定观察遇新 main 必须停止，不能据此重新生成或改指旧人工稿；正常事件入口沿既有候选更新与人工保护合同处理。旧共享 cron、资源、权限和其他消费者不由此文或此补丁退役。

中央 Governance Promotion 按已采用策略保留每日对账及 Native 完成事件，Sync automation-health 保留每小时检查。此候选入口交付不改变这些计划；旧 Release cron、quality 轮询及其他消费者的退出须分别具备真实事件接线与迁移证据。


## 人工完成稿的冻结事实

正常真实事件可在原候选已纳入准确 current main、仍未合并且没有 editing/pending 时，验证现有人工稿并冻结 `session.manualValidation`。该可选字段使用 `kind: validated-manual-candidate`；旧六字段 session 保持可读。旧 generated、baseSha、publishedHead、conflict 和失败记录不改。验证不调用模型、push、build 或 mergedSnapshot/verifyHandoff。

只支持固定 LayerScape `.` 单元及 `simple` / `VERSION` 适配器。真实 Git ancestry 必须证明 source 是 head 的祖先；准确 head 中的 RP config、manifest、delivery、VERSION 与七节 notes 均实际读取并校验。普通 blob 使用严格 UTF-8 解码，文件摘要取原文；VERSION 只在版本比较时 trim。读取前后核 PR/head/source/state。快照严格绑定 repository/candidate/PR/branch，未知输入失败。

稳定事实按 `manualCandidateFacts` 的固定字段顺序序列化：kind、repositoryId、candidateId、prNumber、branch、headSha、sourceSha、units、files、projection。units 内依次 id/path/version/tag/notesPath，files 内 path/sha256 并按 path 字典序排序，projection 内 preview/bodyDigest。`factDigest=SHA256(JSON.stringify(facts))`；九字段 candidate identity 的 artifactDigest 为 `sha256:` 加此摘要，epoch 为 `SHA256(JSON.stringify([kind,candidateId,headSha,sourceSha,factDigest]))`。producer 的 repositoryId/runId/attempt/controllerSha/requestKey 仅为证据，不入 epoch。相同事实复用原 producer；固定观察失配不得 fallback 旧G或换对象。

normal 仍为原 11 顶层字段，人工验证成功使用 `status: READY`、`reason: MANUAL_VALIDATED`、`outcome: manual_validated`。它只冻结待办，不等于完成。重复 normal 在旧冲突处理之前重核并复用事实，不把已完成评论改回冲突提示。

人工观察恢复的实际待办为既有固定 candidate-status 评论及 preview。`projection.preview` 是内容部分；完整正文由 `manualCandidateBody` 确定：原 owner marker、准确候选 head、单位版本，再加 preview。只有 observer 才更新该派生结果并原生回读；相同结果无新增写入。人工完成使用 `READY / MANUAL_PROJECTION / done`。

observer artifact 在原严格顶层字段之外统一增加 `projectionEvidence`：旧 G 为 null，人工完成必须为 `{commentId,bodyDigest,previewDigest}`。摘要分别对应完整评论与 preview。D 不得仅信 producer 的 outcome 或这些摘要：须独立核准确 PR、App bot、唯一 owner marker、完整正文、受保护 session.preview/statusCommentId，并重核 head/source/state。缺失、重复、API 未知或移动均不返回完成。

真实漏立即处理样本须保留登记前自然存在的评论/preview 差异，随后由真实 alarm 在原窗口完成；已经完成的重放不算恢复正例。本地 tests 不替代真实产品窗口或 E11 签收。
