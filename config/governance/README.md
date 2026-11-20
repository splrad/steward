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

仅当维护决定已批准暂停中央 Release（原生 workflow ID `311600220`），才将中央仓库变量 `STEWARD_EXPECTED_PAUSED_RELEASE` 设置为 `311600220`。在原仓库身份及默认分支条件之上，此准确值使新源的整个 `release-coordinator` job 跳过，覆盖 schedule 和 workflow_dispatch；它不能取消已接受的旧源运行，也不是原生 workflow 停用状态。

Release 与 Sync Managed Files 的独立健康检查使用相同规则：准确 Release 路径、ID、变量值及实际 `active` 或 `disabled_manually` 状态同时匹配时，记录 `release.yml:WORKFLOW_PAUSED`，跳过该入口最近运行检查和补唤醒。此状态在既有健康 Issue 中变化时通知一次，并保留在运行摘要；它本身不使健康 job 失败，也不代表发行或产品验收通过。变量为空或错误值时按实际状态执行正常检查；ID 不符不能取得预期暂停语义。其他入口异常、未知状态及 API/通知故障仍保留，`disabled_inactivity` 的原有恢复流程不被该变量屏蔽。

Release 保留单一 schedule `4-59/5 * * * *`，每五分钟一个计划时点。改变 cron 可能重新激活工作流，采用前须原生读回准确暂停变量，分别保存并停用 Release `311600220` 和 Sync Managed Files `408662213`，核清旧源业务及健康在途。采用后应以准确新源原生运行核验协调 job 为 skipped、业务步骤未执行及独立健康行为；静态检查或整个运行成功不能替代暂停证明。恢复 `active` 而保留准确变量时，业务仍被抑制、健康仍记录暂停；健康使用 job 环境快照。只有完成采用和暂停验证、核清在途并进入获准恢复窗口后，才按原生读回顺序恢复各入口并清除变量。后续真实 schedule 的业务收敛另行验收，不由暂停证明追认。

采用此行为、设置变量和实际通知需在同一部署决定中明确；代码合入本身不设置变量。回滚到不含业务启动条件的旧源前，先真实停用入口并核清在途，不能仅依赖变量维持暂停。

## 私有仓 Copier 准入

管理员仓仍运行既有 safe-settings、工具与全部 Action 扫描。新增接纳 `.copier-answers.yml`、标签规则和标签工作流时，必须来自中央受信 checkout 中可达的真实模板版本 tag；来源、键集合及模板字节不符即拒绝。受信 checkout 拉取完整历史与 tags，目标仓不能提供校验模板。

私有目标仓的原生变量 `STEWARD_PRIVATE_GOVERNANCE_REPOSITORY_ID` 登记该仓准确数字 ID；受信 scope 和检查步骤同时读取并绑定原生事件中的真实 ID、SPLRAD 组织身份与 private 状态。该角色仅用于无产品代码的治理样本：只允许 README、六个准确公共模板文件、Copier answers 和派生 actions.lock；head 必须完整，bootstrap base 可仅有 README。每个模板文件逐字节核对受信 tag，全部直接与传递 Actions 使用既有在线安全扫描及原生锁验证。任何产品源码、生态依赖、工具锁、任意工作流或 safe-settings 文件都会失败，不借用管理员的上游依赖锁。

准确登记保留在私有目标仓的原生变量中，不向中央公开配置添加仓名或编号。变量设置和 App 安装范围须在采用决定中明确；没有登记时继续使用原检查路径，错误 ID 或公共仓登记立即失败。该变量不能让产品代码绕过依赖检查：封闭输入范围会拒绝这类仓库。

## 事件递送与独立健康入口

模板业务只接受三类唤醒：Governance Promotion 实际发布新模板 tag 后发送的固定治理 App 事件、已验证仓库事件后的同类通知，以及明确的人工恢复。事件不携带目标仓、源码 SHA、私有路径或命令；消费者重新枚举自身安装范围并选择受信版本。普通 push、没有新 tag 的 Promotion 及每小时健康 schedule 不执行 bootstrap 或模板写入。模板源码变更经 Native Validation 和既有 Promotion 采用后递送。

私有设置入口可在成功处理已验证的仓库事件后，以现有治理 App 的中央单仓 contents/metadata token 发送上述固定通知；它不传递原始事件元数据，标签事件不触发模板通知。对应 `STEWARD_TEMPLATE_EVENTS` 和中央 `STEWARD_TEMPLATE_APPLY` 均须按采用决定启用。设置同步自身的事件功能保持原样。

每小时 schedule 仍只负责独立健康观察。健康补唤醒 Sync Managed 时显式使用 `health_only=true`，不会绕过事件限制形成周期模板写入；手动恢复才使用默认的业务入口。丢失事件保持原生失败记录，按明确的原生手动恢复处理，不新增轮询或自动重试框架。

`STEWARD_TEMPLATE_APPLY` 只启用文件 App 当前 selected 安装范围内的递送。空仓首提交另由 `STEWARD_BOOTSTRAP_APPLY` 控制，默认不启用；其治理 App 为 all 安装，因此启用该开关涉及当前和未来安装空仓，必须另有明确范围授权。本批已有非空仓接入不需要开启它。`bootstrap_only` 仍只能使用既有私有精确验收对象控制。
