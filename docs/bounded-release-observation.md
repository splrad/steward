# 固定对象发行观察

Worker 的 `BOUNDED_RECHECK_ENABLED` 控制共享观察和治理事件。切换生产版本时沿用已晋级控制器、已审维护提交及渠道绑定，回读生效版本和对应原生 Run。

## 官方候选事件

Worker 验签产品事件，核对产品最新受保护默认分支和采用声明后，经 [官方候选工作流](../.github/workflows/release-candidate-event.yml) 处理产品推送、受信的候选正文编辑及合并周期后的候选刷新。入口核对当前 main、原生 Run 和自身工作流身份，由正式 Release Please Action 创建和刷新候选，Steward 复核并排版首页。逐仓暂停、重复投递和原运行恢复按[发行来源合同](release-source-contract.md)执行。

## WinGet

[Worker 的 currentWinget](../workers/steward/src/bounded-winget-evidence.ts) 以受保护且已核验的原 cycle 为输入，只构造 layerscape/winget 单目标：

`cycle_id/source_sha/execution_sha/controller_sha/targets_json/mode/operation_key/request_key`，其中 mode 固定 observe。操作摘要沿用 `channelTargetsDigest`；request key 为 `SHA256(JSON.stringify(['observe',targetsDigest,executionSha]))`。DO 槽位键不得替代这个现有兼容字段。

首次登记由 Worker 核准确成功 submit Run、job、`channel-<requestKey>-layerscape-winget-<runId>-<attempt>/report.json` 及原生 upstream PR。PR 身份来自已核 submit item 的 `nativeObjectId`，T0 使用原生 PR `created_at`；合并后 index 阶段使用原生 merge 时间。仅凭可变请求体、名称搜索或 Run 成功不能登记。

index 复用 `probe-<cycleId>-<targetsDigest>-<runId>-<attempt>/report.json`，核原生 observe job、run/attempt、SHA、摘要、时间窗和准确 PR number/node_id。只有新鲜 `OK/exists/accepted/indexed` 且 `evidenceKind=github-pr:<registeredNumber>` 才满足索引完成。模板仅将 observe job 限制为 5 分钟，并避免 WinGet 单目标无关的 GHCR 登录；没有安装验证。

## 发行切换与历史记录

正式候选、构建和发布由已采用 v3 的产品声明与现行原生工作流受理。候选推送绑定产品受保护的准确主支提交，官方构建回执绑定原 Run 和同一受保护冻结周期。逐仓暂停由设置仓受保护的 `release-pauses.json` 管理。

旧候选接收、状态评论触发、观察派发及其入队和控制入口已退役。既有记录与原生 Run 留在原对象。已获准的仓库 App 可通过 `/internal/bounded-rechecks/v1/status` 查询原身份状态，查询不建立或唤醒旧任务。

旧工作流 311600220 的四个原生 Run 于 2026-11-21 回读均为 completed，最后一次为 [43500446376](https://github.com/splrad/steward/actions/runs/43500446376)。

旧候选、人工完成稿和原观察回执按原提交、原 Run 与原 Git 对象复核。可参阅[历史操作说明](https://github.com/splrad/steward/blob/c285163a632d3d7cd89aeb9f7c090bf97fa4784c/docs/bounded-release-observation.md)。
