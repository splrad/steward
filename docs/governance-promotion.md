# 治理版本提升

[Governance Promotion](../.github/workflows/governance-promotion.yml) 核验中央 Native Validation 的真实 workflow ID、路径、仓库 ID、main push、当前提交和完整 jobs。范围与汇总 job 必须成功；可信工作流中按范围选择的 job 可为 skipped，其适用性由成功的汇总核验。其他失败、取消或缺失结果都会阻断采用。它从默认分支受审源码执行，并在获取治理 App 安装令牌前再次核对 main。

workflow_run 只接收 main 分支事件，job 先筛选中央仓库的成功 main push。独立预检步骤使用只读 token，未注入治理私钥；其结果只决定是否进入后续步骤。获取治理凭据的步骤重新读取原生来源和当前 main，预检文件不能充当写授权。

扫描采用独立决策 `E07-PROMOTION-WORKFLOW-RUN-20261031`：只接受 `.github/workflows/governance-promotion.yml` 的准确 `on.workflow_run` 原生 dangerous-triggers 诊断。原始扫描结果和非零退出码保留；其他发现继续失败。此诊断例外不替代事件来源、ref、job 权限、environment 和写入前复核，也不改变工作流修改的常规审查要求。

采用前设置真实 `NATIVE_VALIDATION_WORKFLOW_ID`、`GOVERNANCE_APP_ID` 和 `steward-automation/GOVERNANCE_APP_PRIVATE_KEY`，完成首次模板标签与组织规则交接，再启用 `STEWARD_GOVERNANCE_PROMOTION`。这些原生登记和部署状态需要分别回读；本地实现不等于线上启用。

提升与 bootstrap 共用 `steward-governance-mutation` 原生 job 并发组。每笔已通过当前主线验证的晋级都可以推进 `steward/validated-controller`。组织默认分支规则集 18883080 中的 Native Validation 保留既有不可变 SHA，直到可信工作流或其策略源码、执行依赖及工具锁发生变化。比较以规则当前生效的 SHA 为起点，检查 Git 路径、模式与对象，并遍历两端实际调用的本地工作流、Action、脚本和策略输入。目标仓工作区路径、从已批准标签加载的模板快照和 Worker 独立锁属于各自原有的验证链。

每次写入前复核 main、controller 来源保护与规则集的非 SHA 字段。模板标签、控制器引用与唤醒步骤复读实际生效的验证器 SHA。其中的安全政策模板与私仓产品运行时从另行保护的 controller 祖先读取，验证器代码继续运行在规则所固定的提交。配置审批重跑先读取目标分支生效规则，再确认 GitHub 为该 Run 记录的工作流文件来源及 PR head。

其他规则与未知字段取自写前最新的完整读取。证据保存完整写前、写后对象。原生 PUT 没有 CAS 保证。丢失响应时先回读，已采用目标 SHA 即成功，仍为旧值才可重试，出现第三个 SHA 时停止。

切换 pin 前，治理 App 以独立的 Actions Variables 权限将补验意图写到私有的 `splrad/steward-settings`。切换完成后只盘点受这套规则约束的开放 PR。已有该 pin 的原生 Run 时，按准确 head、工作流来源、Run、attempt 和汇总 job 记录实际状态。缺少 Run 时，现有 Steward App 用仅限目标仓的 PR 权限执行原生关闭和重开，GitHub 据 reopened 事件运行必需工作流。Dependabot 和 Renovate 创建的 PR 按 GitHub 作者 ID 识别。缺少新验证器的运行时，PR 保持开放，补验记录为 `dependency-managed`。机器人更新分支或维护者同步基底后，补验按新提交与生效验证器核验原生运行；等待期间，合并仍须满足组织必需检查。草稿、发行候选、自动合并和合并队列保留待办。补验通过已有 GitHub App 安装完成，使用已登记的 `steward-automation/STEWARD_APP_PRIVATE_KEY`。

GitHub 在 PR 有合并冲突时不会启动 `pull_request` 工作流。补验在关闭前重新确认 GitHub 报告的合并状态。合并冲突、落后基底或合并状态待计算时，保留 PR 和等待原因。落后 PR 的 reopened 事件可能继续携带旧基底，Native Validation 仍要求事件基底与同次 checkout 的目标分支一致。发生差异时，`VALIDATION_BASE_MOVED` 记录这两个提交。正常同步后按新 head 查找原生 Run。已经由 App 重开的同一 head 继续观察原生结果。

补验在私有记录中保存原生状态转换的初始位置，并在发送关闭请求前保存请求意图。如果请求结果不明，待办保留到原生事件可确认。组织 pin 的下一次切换在未确认的关闭处理完成后继续，控制器仍可以晋级。进程中断后只有后继关闭事件仍由同一 App 执行，且没有更新的状态转换时，才恢复重开。人工关闭保留原状。待办的 PR head 前进时，保留前一 head 的证据，并为新 head 先等待自然 synchronize 所产生的原生 Run。原生 Run 在途、失败或重开仍未看到 Run 时记录对应状态，日程或手工晋级可继续复读原有待办。pin 不变时继续核对现有待办，无需重新盘点所有仓。中央公开产物只含补验状态计数和脱敏错误码，逐项 PR 与 Run 证据位于私仓变量 `STEWARD_VALIDATOR_REVALIDATION`。

模板晋级比较 `copier.yml`、`templates/repository` 和公共安全政策。模板包含 PR 标题调用方时，也比较对应的复用工作流。实际变化从最新已采用 PEP 440 稳定版本生成严格递增标签，标签固定到同一个已验证提交。SDK 单独变化不产生模板版本。标签创建前后核对全部标签快照和目标指向；同名异对象、外部标签漂移和未知响应不执行覆盖。下一次原生 Copier 递送从已发布标签继续。

治理 App 创建模板或控制器标签时，[发行工作流](../.github/workflows/template-release.yml)接收该标签的 `push` 事件，核对创建标记、发送者、完整引用和提交。Release Drafter 按[模板输入路径](../.github/template-release.yml)为 **Steward 仓库模板** 选取两版之间已合并的 PR。**Steward 治理控制器** 的[发行说明](../.github/controller-release.yml)包含从上一编号的控制器标签到本次标签之间已合并的 PR。工作流在本仓自动公开对应的发行版。发行失败可重跑该标签的原运行，已公开的同一版本会跳过。

原生 Run 的证据产物含来源、规则前后状态和模板计划，不含令牌。故障恢复使用原 Run 重跑；旧 main 的运行只记录过期结果。每日补扫会重新查询当前 main 的原生验证结果。历史 SQL 保留在 [runtime](../packages/runtime/history/README.md)，不参与新入口的授权。
