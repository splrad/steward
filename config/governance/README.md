# 原生治理规则准备

`node scripts/prepare-governance.mjs native-snapshot.json native-drafts.json` 从原生回读生成 Ruleset 请求正文。脚本仅在本地生成新文件，拒绝覆盖已有输出。它用于部署准备，不参与产品运行。

输入包含基础组织 Ruleset `base`（ID `18883080`）、例外团队 `team`、完整成员列表 `members`、独立治理 App `governanceApp` 及其组织安装 `installation`、成功的 `SPLRAD Validation` 检查 `validationCheck`、已审提交 `policySha`。团队和治理 App 的 ID 必须来自实际对象；测试中的 ID 只用于夹具。`legacyCandidates` 可列出仍需按仓保护的旧候选分支，每项提供准确 `repositoryId` 和 `branch`。已退役的 `steward/release-candidate` 不接受生成请求。

输出包含基础规则、独立标题规则、独立审批规则、五条运行时规则及按仓库限定的旧候选分支规则。基础规则保留 `SPLRAD Validation`、其他既有检查及 required workflow，清空旧批准者要求。`默认分支 PR 标题检查（Steward 除外）` 在其余仓的默认分支要求 `SPLRAD PR Title`。`SPLRAD 拉取请求审批` 仅给单成员团队 `stewardship` 提供 PR 范围的批准例外。

五条运行时规则的显示名称为 `Steward 运行状态写入限制`、`Steward 治理状态写入限制`、`Steward 自动化分支创建限制`、`Steward 自动化分支完整性保护` 和 `Steward 构建分支不可变`。按相同的规则参数和允许身份合并分支范围。状态及治理写入者分别授权，受管同步分支允许正常快进，构建分支创建后保持不可变。Release Please 正式候选使用适用产品仓的准确分支规则，保留 GitHub 合并后自动删枝。

`assertApprovalUnion` 校验完整有效 Ruleset 集合及旧 branch protection，识别会抵消例外的附加批准要求。调用者须先通过原生接口枚举全部适用规则；只有确认旧保护不存在的 404 才能传入 `null`，权限或网络错误必须保留为失败。该函数检查配置，真实合并操作者、失败检查、未解决线程和未归属变更的效果另以原生 PR 验证。

部署时先保存当前规则恢复点，再核对受信验证和标题入口在准确 PR/head 上的结果。先启用独立标题规则并读回其生效范围，再从基础规则移除标题检查。脚本生成请求正文，执行顺序由维护者控制。请求正文使用原生 `sha` 固定 required workflow 来源。具体字段参考 [GitHub 组织 Rulesets API](https://docs.github.com/en/rest/orgs/rules)。

组织所需 Native Validation 对 `.github/workflows/pr-title.yml` 的改动、移除和重命名执行既有配置授权。Copier 递送 PR 由管理员或已授权的委托人审核实际 head，并通过现有配置审核入口确认。GitHub 状态规则按检查名和 App 匹配，配置授权由已固定来源的 Native Validation 执行。

## Actions 事件策略采用

Actions 事件策略通过 GitHub 设置页或官方 REST 在采用阶段配置并读回。设置同步只运行 safe-settings 支持的设置；事件策略不由定时 settings-sync 读取或修复。

`tools/settings-sync/actions-policies.mjs` 保留为部署准备辅助模块。`readActionsPolicies` 完整读取组织、仓库及继承策略，403 或未知响应保持失败。`reconcileActionsPolicies` 只处理明确登记 ID、作用范围和预期旧值的一次性变更，支持准确标题路径、公开仓准确贴标路径，以及保留全部专用路径排除项的通用事件。调用者在 E10 的具体授权范围内使用官方 Octokit request 适配器，先预览，再采用并核验读回。该模块没有定时入口。`config/governance/actions-policies.json` 当前未登记任何策略 ID。

新入口采用前，先保存完整原生快照，核对全部继承策略和实际拒绝来源。标题策略仅匹配 `.github/workflows/pr-title.yml`，采用后使用 `pull_request`。公开仓贴标策略按系统属性 `visibility=public` 和准确的 `.github/workflows/pr-labeler.yml` 覆盖当前与未来采用仓。原生验证和 Product CI 适用通用事件策略。通用策略应排除已有专属事件策略覆盖的路径。作用范围变更使用已审原生请求。

写响应未知时先 GET 准确策略，保留无关字段及后来修改，再决定后续操作。真实验收包含标题 edited/fork、其他路径拒绝，以及维护、发布和恢复所需事件；本地请求测试不替代原生事件验收。接口参见 [GitHub Actions policies](https://docs.github.com/en/rest/actions/policies)。

## 中央 Release 暂停

有界发行及 Pages 事件入口核对当前 main、触发 Run 与现役工作流状态。切换时从受审 Git 树确认旧写者已退出，并用原生 Run 清单确认旧工作流已排空。历史工作流 311600220 保持停用供追溯。

## 私有仓 Copier 准入

管理员仓仍运行既有 safe-settings、工具与全部 Action 扫描。新增接纳 `.copier-answers.yml`、标签规则和标签工作流时，必须来自中央受信 checkout 中可达的真实模板版本 tag；来源、键集合及模板字节不符即拒绝。受信 checkout 拉取完整历史与 tags，目标仓不能提供校验模板。

私有目标仓的原生变量 `STEWARD_PRIVATE_GOVERNANCE_REPOSITORY_ID` 登记该仓准确数字 ID；受信 scope 和检查步骤同时读取并绑定原生事件中的真实 ID、SPLRAD 组织身份与 private 状态。该角色仅用于无产品代码的治理样本：只允许 README、六个准确公共模板文件、Copier answers 和派生 actions.lock；head 必须完整，bootstrap base 可仅有 README。每个模板文件逐字节核对受信 tag，全部直接与传递 Actions 使用既有在线安全扫描及原生锁验证。任何产品源码、生态依赖、工具锁、任意工作流或 safe-settings 文件都会失败，不借用管理员的上游依赖锁。

准确登记保留在私有目标仓的原生变量中，不向中央公开配置添加仓名或编号。变量设置和 App 安装范围须在采用决定中明确；没有登记时继续使用原检查路径，错误 ID 或公共仓登记立即失败。该变量不能让产品代码绕过依赖检查：封闭输入范围会拒绝这类仓库。

## 模板事件递送

模板业务只接受三类唤醒：Governance Promotion 实际发布新模板 tag 后发送的固定治理 App 事件、已验证仓库事件后的同类通知，以及明确的人工恢复。事件不携带目标仓、源码 SHA、私有路径或命令；消费者重新枚举自身安装范围并选择受信版本。模板源码变更经 Native Validation 和既有 Promotion 采用后递送。

私有设置入口可在成功处理已验证的仓库事件后，以现有治理 App 的中央单仓 contents/metadata token 发送上述固定通知；它不传递原始事件元数据，标签事件不触发模板通知。对应 `STEWARD_TEMPLATE_EVENTS` 和中央 `STEWARD_TEMPLATE_APPLY` 均须按采用决定启用。设置同步自身的事件功能保持原样。

`STEWARD_TEMPLATE_APPLY` 只启用文件 App 当前 selected 安装范围内的递送。空仓首提交另由 `STEWARD_BOOTSTRAP_APPLY` 控制，默认不启用；其治理 App 为 all 安装，因此启用该开关涉及当前和未来安装空仓，必须另有明确范围授权。本批已有非空仓接入不需要开启它。`bootstrap_only` 仍只能使用既有私有精确验收对象控制。

### 旧配置工作流的 Actions 策略收尾

维护窗口须单独批准。`config/governance/actions-policies.json` 当前为 `policies: []`。合入本辅助模块只改变将来显式登记 11334 时允许的形状；空注册表通过校验不能证明线上策略已切换。

**切换前。** 从组织 Actions policies API 保存 11334、16429、16430 的完整原生定义和各仓继承明细，记录当前启用状态、仓库 ID、路径条件及事件。11334 当前覆盖 LayerScape、steward、.github，允许 `pull_request`、`push`、`schedule`、`workflow_dispatch`、`workflow_run`、`release`、`workflow_call`。16429 对 LayerScape 的旧路径还允许 `pull_request_review` 和 `issues`，16430 对其余两仓的旧路径允许相同的七类通用事件。

检查所有保留分支和标签、开放 PR、在途运行及四仓默认分支。上次核查时，LayerScape 的 `steward/release-candidate`（`e19c350e`）和验收 PR #233 的 `validation/python-delivery-20261121`（`8540f858`）仍有 `.github/workflows/repository-configuration.yml`，同一 blob `3512eda6` 声明 `pull_request_review` 与 `issues`。#233 的 Python 验收另走 push 工作流。记录这两个头的当前 SHA、旧事件有无消费者，以及验收工作流状态。如果仍需这两类事件，或引用发生变化且影响未查清，保留原策略并暂停切换。此次维护不处置这两个分支。 [验收 #233](https://github.com/splrad/LayerScape/pull/233) · [旧工作流](https://github.com/splrad/LayerScape/blob/8540f8587bd32cf86415d1a64f9ee23c8b27f692/.github/workflows/repository-configuration.yml)

**切换与读回。**

1. 用保存的 11334 构造临时登记，使用[旧版校验模块](https://github.com/splrad/steward/blob/1d43b0b6c8004f635f28f961e675773c4f170219/tools/settings-sync/actions-policies.mjs)的 `validateActionsRegistry` 核对四项路径排除。复制该登记，只从排除项中移去旧配置路径，再用本 PR 的校验模块核对三项形状。两个临时登记都使用原仓库和事件，保留正式空注册表。
2. 在首次策略写入前复核快照和两类事件的退出决定。只修改 11334 的这一个排除项。扩展通用覆盖的这一步就可能限制旧路径的 `pull_request_review`、`issues`。逐仓读回七类通用事件和余下三项排除（`pr-title.yml`、`sync-managed.yml`、`pr-labeler.yml`），对照标题、贴标、模板同步和原生验证各自的有效事件及运行。如有偏差，立即回退。
3. 逐一停用 16429、16430，每次读回原生定义和目标仓继承。确认旧路径已有通用保护，其他仓、其他路径及事件符合快照。专用策略按其独立的原生定义验收。
4. 分别复核并处理历史 workflow 登记：steward `424786417`、.github `424413230`、steward-settings `424413483`。各自须具备原状态记录、无活跃消费者且运行均已终止，再逐项停用和读回。LayerScape `424667651` 已是 deleted。保留历史 Run；若 GitHub 拒绝停用无源码的登记，记录原生响应、引用和未完成项。

**回退。** 按操作记录只恢复已改项。先以快照恢复 16429、16430 原来的启用状态、精确仓库和事件，逐仓确认专用保护已就位。随后恢复 11334 的旧路径排除并用上述固定旧版校验器复核四项形状。重新从各仓读取有效覆盖，核对 LayerScape 旧路径的九类事件、另两仓七类事件以及其余路径原有权限。若曾停用历史 workflow，按原 ID 恢复对应登记并读回；遇到平台拒绝时保留原生响应，单列未恢复项。以策略定义、继承、工作流状态和相关运行的读回结果结案。
