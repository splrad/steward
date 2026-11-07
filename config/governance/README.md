# 原生治理规则准备

`node scripts/prepare-governance.mjs native-snapshot.json native-drafts.json` 从原生回读生成 Ruleset 请求正文。脚本仅在本地生成新文件，拒绝覆盖已有输出。它用于部署准备，不参与产品运行。

输入包含基础组织 Ruleset `base`（ID `18883080`）、例外团队 `team`、完整成员列表 `members`、独立治理 App `governanceApp` 及其组织安装 `installation`、成功的 `SPLRAD Validation` 检查 `validationCheck`、已审提交 `policySha`。团队和治理 App 的 ID 必须来自实际对象；测试中的 ID 只用于夹具。`legacyCandidates` 可列出已发现的旧候选分支，每项提供准确 `repositoryId` 和 `branch`。

输出分为基础规则、独立审批规则、五条运行时规则及按仓库限定的旧候选分支规则。基础规则保留无关限制、既有检查和其他 required workflow，清空旧批准者要求；独立规则仅给单成员团队 `primary-account-approval-exception` 提供 PR 范围的批准例外。运行时规则分别为 `steward-state-writer`、`steward-governance-writer`、`steward-ref-creator`、`steward-ref-integrity` 和 `steward-build-immutable`，按相同的规则参数和允许身份合并分支范围。状态及治理写入者分别授权；候选分支允许正常快进，构建分支创建后保持不可变。

`assertApprovalUnion` 校验完整有效 Ruleset 集合及旧 branch protection，识别会抵消例外的附加批准要求。调用者须先通过原生接口枚举全部适用规则；只有确认旧保护不存在的 404 才能传入 `null`，权限或网络错误必须保留为失败。该函数检查配置，真实合并操作者、失败检查、未解决线程和未归属变更的效果另以原生 PR 验证。

部署时先保存当前规则恢复点，再核对受信验证和标题入口在准确 PR/head 上的结果。新验证生效后才逐项移除被其替代的旧 Gate；脚本保留旧检查，不自动决定切换时机。请求正文使用原生 `sha` 固定 required workflow 来源。具体字段参考 [GitHub 组织 Rulesets API](https://docs.github.com/en/rest/orgs/rules)。

## Actions 事件策略采用

Actions 事件策略通过 GitHub 设置页或官方 REST 在采用阶段配置并读回。设置同步只运行 safe-settings 支持的设置；事件策略不由定时 settings-sync 读取或修复。

`tools/settings-sync/actions-policies.mjs` 保留为部署准备辅助模块：`readActionsPolicies` 完整读取组织、仓库及继承策略，403 或未知响应保持失败；`reconcileActionsPolicies` 只处理明确登记 ID、作用范围和预期旧值的一次性变更。调用者在 E10 的具体授权范围内使用官方 Octokit request 适配器，先预览，再采用并核验读回。该模块没有定时入口，不自动创建策略。`config/governance/actions-policies.json` 当前未登记任何策略 ID，不能据此认定生产策略为空或已经采用。

新标题入口采用前，先保存准确对象的完整原生快照，核对全部继承策略和实际拒绝来源。按现行规范使用组织 `repository_name.include=["~ALL"]` 覆盖当前与未来仓库；标题许可仅匹配 `.github/workflows/pr-title.yml`。其他工作流保留所需事件并排除 `pull_request_target`，不得用新增宽松策略抵消未知的继承限制。扩大到未来仓库或初次创建策略使用已审原生请求；现有按仓库 ID 登记的辅助模块不转换这类作用范围。

写响应未知时先 GET 准确策略，保留无关字段及后来修改，再决定后续操作。真实验收包含标题 edited/fork、其他路径拒绝，以及维护、发布和恢复所需事件；本地请求测试不替代原生事件验收。接口参见 [GitHub Actions policies](https://docs.github.com/en/rest/actions/policies)。

## 已知 Release 暂停的健康观察

`release.yml` 和 `sync-managed.yml` 仍独立读取两个固定入口。默认情况下，人工停用继续记录 `WORKFLOW_DISABLED` 并使健康 job 失败；不会 enable 或 dispatch 人工停用的入口。

仅当维护决定已批准暂停中央 Release（原生 workflow ID `311600220`），才将中央仓库变量 `STEWARD_EXPECTED_PAUSED_RELEASE` 设置为 `311600220`。准确路径、ID 和实际 `disabled_manually` 状态同时匹配时，记录 `release.yml:WORKFLOW_PAUSED`。此状态在既有健康 Issue 中变化时通知一次，并保留在运行摘要；它不使健康 job 失败，也不代表发行或产品验收通过。变量为空、ID 不符、其他工作流停用、未知状态及 API/通知故障仍失败。原生状态恢复为 active 时照常检查最近运行，变量不能屏蔽失活或漏唤醒。结束维护时应清除该变量；Release 的启用需对应的发行授权。

采用此行为、设置变量和实际通知需在同一部署决定中明确；代码合入本身不设置变量。
